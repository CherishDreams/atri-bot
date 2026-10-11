import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./core/logger.ts";
import { AgentEngine } from "./core/agent/engine.ts";
import { SessionEvents } from "./core/agent/events.ts";
import { SessionLock } from "./core/session/lock.ts";
import { SessionManager } from "./core/session/manager.ts";
import { ProviderRegistry } from "./core/provider/registry.ts";
import { createProviders, readDefaultProviderId } from "./core/provider/factory.ts";
import { ProviderConfigStore } from "./core/provider/store.ts";
import { ToolRegistry } from "./core/tool/registry.ts";
import { ToolConfigStore } from "./core/tool/store.ts";
import { createBuiltinTools } from "./core/tool/builtins.ts";
import { AuthManager } from "./core/auth/manager.ts";
import { ApiError, errorMessage } from "./core/errors.ts";
import { PluginManager, pluginRuntimeConfig } from "./plugins/manager.ts";
import { AdapterManager } from "./adapters/manager.ts";
import { createHttpServer } from "./api/server.ts";
import type {
  ProfileBundle,
  ProfileDirectory,
  ProviderSurface,
  ProvidersView,
} from "./api/http.ts";
import type { AppConfig } from "./config/index.ts";
import {
  configFilePath,
  ensurePrivateDir,
  ensurePrivateFile,
  providersFilePath,
  readConfigFile,
} from "./config/file.ts";
import type { ProvidersFileConfig, ProviderSourceEntryConfig } from "./config/file.ts";
import {
  DEFAULT_PROFILE_ID,
  assertProfileId,
  listProfileDirs,
  migrateProvidersToGlobal,
  profileConfigPath,
  profileDir,
  profilesRoot,
  providerShapeKeysIn,
  readProfileConfig,
  runShapeKeysIn,
  seedProfile,
  setProfilePluginEnabled,
  updateProfileConfig,
  writeProfileConfig,
} from "./config/profiles.ts";
import type { ProfileFileConfig } from "./config/profiles.ts";
import type { ProfileRecord, ProfileStatus } from "@atri/shared";

/** 配置档文件里的插件段 -> 显式关掉的 id 列表（默认启用，判据 `=== false`）。 */
function disabledPluginsOf(profile: ProfileFileConfig): string[] {
  return Object.entries(profile.plugins ?? {})
    .filter(([, toggle]) => toggle?.enabled === false)
    .map(([id]) => id);
}

/** 一份对象图 -> 它在目录里的那条状态。`ready` 的四个字段永远从同一个来源算。 */
function readyState(bundle: ProfileBundle): ProfileState {
  return {
    name: bundle.name,
    status: "ready",
    error: null,
    defaultProviderId: bundle.defaultProviderId,
  };
}

/** 一份配置档在目录里的状态（成功的那些也在这里，为的是 `records()` 一次算完）。 */
interface ProfileState {
  name: string;
  status: ProfileStatus;
  error: string | null;
  /** 这一档默认用哪个 provider 实例（`null` = 用全局 `providers.default`）。 */
  defaultProviderId: string | null;
}

/**
 * 组合根（composition root）：唯一知道各部件如何拼装的地方。
 * 下层通过构造函数注入协作者，彼此互不感知，
 * 从而让 core/ 不掺杂任何传输层细节。
 *
 * ## 现在这里拼装的是「一份全局 + N 份跑法」
 *
 * **供应商是部署级全局的一份**（`providers.json` + 一个 `ProviderRegistry` + 一份失败表），
 * 连它那些「哪一条没跑起来」的诊断一起。一份配置档 = 一套**跑法**：`ToolConfigStore` /
 * `ToolRegistry` / `PluginManager` / `AgentEngine`，外加「默认用全局清单里的哪一个」。
 * 跨配置档共享的因此是六样：登录、会话存储、**会话锁**、**事件总线**、供应商那一份文件，
 * 以及由它装出来的那一张注册表。锁与总线必须是共享的，理由写在
 * `core/session/lock.ts` 与 `core/agent/events.ts` 各自的类注释里 —— 一句话版本：
 * 历史是全局一份 sqlite，而「同一个会话不能同时跑两轮」不是任何单个配置档的内部事务。
 */
/**
 * 服务端自己的版本号，读 `apps/server/package.json`（与 `api/server.ts` 读 `openapi.json`
 * 同一个写法：以 `import.meta.url` 为基准，因此与启动目录无关）。
 *
 * 为什么不让 `api/` 自己去读：那一层不该知道磁盘布局，而「哪一版」是装配那一次就定下来的
 * 部署事实。`test/openapi.test.ts` 有一条把 `/health` 的版本、这份 package.json 与
 * `openapi.json` 的 `info.version` 三者钉在一起 —— 写死字符串时它们是各说各话的。
 */
function readServerVersion(): string {
  const raw = readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
  // JSON 边界：`JSON.parse` 交出 unknown，这里只认领 `version` 那一个键。
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("apps/server/package.json 里没有可用的 version —— /health 的版本无从可说");
  }
  return parsed.version;
}

export async function createApp(config: AppConfig) {
  const logger = createLogger(config.logLevel);

  const auth = new AuthManager(config, logger);
  // 必须早于 HTTP 服务启动：未配置口令时要先把随机口令写进配置文件。
  await auth.init();

  // 会话与消息落在 `config.dataDir` 下的 sqlite（建库与 schema 升级见 `core/session/db.ts`）。
  const sessions = new SessionManager(config, logger);
  const lock = new SessionLock();
  const events = new SessionEvents();

  // 「跑法」住在配置档文件里，供应商住在 `providers.json`，都不在 `atri.config.json`。
  // 顺序是有意的：先建目录、再一次性 seed、**然后**才构造任何对象图 —— 存储拿到的一直是
  // 真正那个文件的路径。
  const profilesDir = profilesRoot(config.dataDir);
  ensurePrivateDir(profilesDir);
  const seedPath = profileConfigPath(profilesDir, DEFAULT_PROFILE_ID);
  const bootstrap = readConfigFile(config.root);
  // 供应商那一份全局文件落在 `dataDir` 下（与 `sessions.sqlite`、`profiles/` 同级）：
  // 它是运行期数据而不是部署参数，备份 `dataDir` 就该连它一起带走。路径先算出来，
  // 因为下面那句「bootstrap 里还留着运行期段」的警告要说清真源在哪。
  const providersPath = providersFilePath(config.dataDir);
  // 里面躺着口令，seed 之后还可能躺着已经失效但仍是明文的 `apiKey`。这一轮之后
  // bootstrap 文件唯一的写入者是「首次生成口令」那条路径，老部署里 0644 的那一份
  // 再没有别的动作会去收紧它 —— 所以收紧这一步必须是**启动**做的，而不是等某次保存。
  ensurePrivateFile(configFilePath(config.root));
  const moved = seedProfile(profilesDir, DEFAULT_PROFILE_ID, bootstrap);
  if (moved !== null) {
    logger.info(
      moved.length === 0
        ? `已创建配置档「${DEFAULT_PROFILE_ID}」（${seedPath}）`
        : `已把 atri.config.json 里的 ${moved.join(" / ")} 搬进配置档「${DEFAULT_PROFILE_ID}」——` +
            "这一段以后只在配置档文件里维护",
    );
  }

  // bootstrap 里留着运行期段就是一句谎话，**与这次是不是第一次启动无关**：不删用户的
  // 文件（框架从不删它），但每次启动都要说一次，否则它会变成第二个真源。
  const leftover = runShapeKeysIn(bootstrap);
  if (leftover.length > 0) {
    logger.warn(
      `atri.config.json 里还留着 ${leftover.join(" / ")}，但它们**已经不再生效** —— ` +
        `供应商的真源是 ${providersPath}，工具与步数的真源是 ${seedPath}。` +
        `其中可能仍有明文的 provider apiKey：确认无误后把它们从 atri.config.json 里删掉。`,
    );
  }

  // 旧的插件数据根（`<dataDir>/plugins`）不再被读。**既不迁也不删**：里面可能是
  // 某个插件存的 token 或用户数据，猜错了就是不可恢复的损失，而搬迁的正确形式取决于插件
  // 自己怎么用它（有的按 id 存会话、有的存缓存）。所以只说一次该跑什么。
  const legacyDataRoot = join(config.dataDir, "plugins");
  if (existsSync(legacyDataRoot)) {
    logger.warn(
      `检测到旧的插件数据根 ${legacyDataRoot}，现在每个配置档有自己的数据根 ` +
        `${join(profilesDir, "<配置档 id>", "plugins")}。框架不搬也不删，需要保留那些插件的` +
        `登录态与缓存请自己移动，例如：mv ${legacyDataRoot} ${join(profilesDir, DEFAULT_PROFILE_ID, "plugins")}`,
    );
  }

  /** id -> 状态。`failed` 的那些只有这里有条目（没有对象图）。 */
  const states = new Map<string, ProfileState>();
  /** id -> 对象图。只装 `ready` 的那些。 */
  const bundles = new Map<string, ProfileBundle>();

  // --- 供应商：部署级全局的一份 ---------------------------------------------
  //
  // 连接（source）与模型实例（provider）是**部署级**的东西：它们是密钥与端点，按配置档
  // 各存一份只会让同一个 `apiKey` 躺在 N 个文件里，而「换一档换一套后端」其实从来没人在用
  //（档里发消息时传的是文本，模型由选择器或档默认决定）。对齐 AstrBot 也是这一条：
  // 除了配置文件，供应商与工具都是全局的，配置档只管「启用哪些工具、启用哪些插件」。
  //
  // 下面这三样因此只有一份，且**只由 `rebuildProviders()` 写**：文件存储、注册表、失败表。
  const providerConfig = new ProviderConfigStore({ filePath: providersPath }, logger);
  const providers = new ProviderRegistry();
  /**
   * 最近一次装配里**没加载成功**的 provider：`id -> 中文原因`。
   * 由 `rebuildProviders()` 整份重写（不是累加），所以它永远与注册表同源。
   */
  const providerErrors = new Map<string, string>();

  // 一次性把散在各档（或最初的 `atri.config.json`）里的供应商配置收进全局那一份。
  // 必须**早于任何一次装配**：`rebuildProviders()` 读的就是这个文件。
  // `openSessionDb` 已经建过 `dataDir` 并收到 0700，但那是别人的顺序；写盘的前置条件
  // 在这里自己说清，不依赖「构造 `SessionManager` 排在前面」这种看不见的事实。
  ensurePrivateDir(config.dataDir);
  const migration = migrateProvidersToGlobal(profilesDir, providersPath, bootstrap);
  if (migration !== null) {
    logger.info(
      `供应商配置已经收成全局一份（${providersPath}）：从` +
        `${migration.from === "bootstrap" ? " atri.config.json" : " 各配置档"}合并出 ` +
        `${migration.sources.length} 个 source / ${migration.providers.length} 个 provider`,
    );
    if (migration.dropped.length > 0) {
      // 冲突必须点名：「你配的那条被忽略了」不说是哪一条、被谁占了，等于没说。
      logger.warn(
        `合并时有 ${migration.dropped.length} 条被丢弃（同名时由字典序最小的那份配置档赢）：` +
          migration.dropped.join("；"),
      );
    }
  }

  /**
   * 按当前配置装配那张全局注册表。
   *
   * 启动与「配置页改完保存」走的是**同一个函数**，因此不会出现两条装配路径
   * 慢慢走散的情况（例如忘记处理默认值回退）。
   *
   * 单个 provider 配错只记日志、不阻断启动：「其中一个后端坏了」应该能局部降级，
   * 而不是让整个服务起不来。
   */
  function rebuildProviders(): ProviderRegistry {
    providers.clear();
    // 整份重写而不是累加：一次重建就是这批 provider 的**全部**失败事实。
    // 留着上一轮的条目会让 `GET /providers` 给一条已经修好的 provider 配一句旧错误。
    providerErrors.clear();

    let entries: ProvidersFileConfig;
    let sources: Record<string, ProviderSourceEntryConfig>;
    try {
      entries = providerConfig.providerEntries();
      sources = providerConfig.sourceEntries();
    } catch (err) {
      // 整个文件读不出来时**绝不上抛**。以前只坏一档，现在全局一份读坏就会让**每一档**
      // 都变成 `failed` —— 而「配置页打不开、什么都改不动」恰恰是操作者最需要这个服务
      // 还活着的那一刻。这里退化成「一个 provider 都没有」（回声兜底），
      // 原因由 `providersView()` 带给配置页，改好文件后一次保存就恢复。
      logger.error(`全局供应商配置读不出来，本轮不装配注册表: ${errorMessage(err)}`);
      return providers;
    }

    const { providers: built, errors } = createProviders(entries, { sources, logger });
    for (const provider of built) providers.register(provider);
    for (const { id, message } of errors) {
      // 同时留给 `GET /providers` —— 装配是唯一写它的地方。
      providerErrors.set(id, message);
      logger.error(`provider「${id}」加载失败: ${message}`);
    }

    const defaultId = readDefaultProviderId(entries);
    if (defaultId) {
      // 显式配了默认值但它没加载成功时，别静默回退到第一个——那会让请求
      // 悄悄打到另一个模型上。宁可留空，由注册表的回退规则处理并留下日志。
      if (providers.get(defaultId)) {
        providers.setDefault(defaultId);
      } else {
        logger.warn(`全局默认 provider「${defaultId}」未加载成功，将回退到第一个可用 provider`);
      }
    }

    if (providers.size === 0) {
      logger.warn(
        `没有可用的模型 provider，将使用回声兜底（请在 ${providersPath} 里配置 providers）`,
      );
    }
    return providers;
  }

  /**
   * 配置页读的那一份视图。与 `rebuildProviders()` 用同一个存储，但**每次现读**：
   * 文件是半截 JSON 时返回「空清单 + 原因」而不是抛 —— 抛出去的那句里带着绝对路径，
   * 而它的后果是让整张配置页 500，那一刻人已经改不动这个文件了。
   *
   * 为什么不复用装配那一次的结果：那次之后操作者可能直接手改过文件，
   * 视图必须说「此刻文件里写着什么」，否则配置页会显示上一次装配时的旧清单。
   */
  function providersView(): ProvidersView {
    try {
      return {
        entries: providerConfig.providers,
        defaultId: providerConfig.defaultId,
        error: null,
      };
    } catch (err) {
      return { entries: [], defaultId: null, error: errorMessage(err) };
    }
  }

  const providerSurface: ProviderSurface = {
    config: providerConfig,
    registry: providers,
    rebuild: rebuildProviders,
    view: providersView,
    // 交出去的是快照而不是那个 Map 本体：`api/` 拿到的是读得到的事实，
    // 不是一条能改回装配状态的口子。
    loadErrors: () => new Map(providerErrors),
  };

  /**
   * 读一份配置档并**只构造**它的对象图，不登记、不加载插件。
   * 单独成一步是 `POST /profiles/{id}/reload` 的前提：它要先建好**新的**一份，
   * 换掉 Map 里那一条，之后才卸载旧的 —— 在途的那轮对话继续用旧对象图走完。
   * 读文件或校验不过时抛，调用方决定记成 `failed` 还是回给客户端。
   */
  async function buildBundle(id: string): Promise<ProfileBundle> {
    const path = profileConfigPath(profilesDir, id);
    const profile = readProfileConfig(path);
    // 搬完**不删**档里那两段（框架从不删用户写的东西），但那句话每次启动都要说：
    // 留着一段不再被读的 `providers`，下一次排查时它会被人当成真源。
    const stale = providerShapeKeysIn(profile);
    if (stale.length > 0) {
      logger.warn(
        `配置档「${id}」的文件里还留着 ${stale.join(" / ")}，但供应商已经是**全局一份** ` +
          `（${providersPath}）—— 这一段在这份档里不再生效，确认无误后从 ${path} 删掉，` +
          `里面可能仍有明文的 apiKey。`,
      );
    }
    const defaultProviderId =
      typeof profile.defaultProvider === "string" && profile.defaultProvider
        ? profile.defaultProvider
        : null;
    if (defaultProviderId !== null && providers.get(defaultProviderId) === null) {
      // 说得出名地提醒，而不是让每条消息静默落到别的模型上：注册表的 `#resolveFor`
      // 会退到全局默认、再退到第一个可用的，症状是「默认写着 A，回的却是 B」。
      logger.warn(
        `配置档「${id}」的默认 provider「${defaultProviderId}」当前没有加载成功，` +
          `将回退到全局默认（清单见 ${providersPath}）`,
      );
    }
    const toolConfig = new ToolConfigStore({ filePath: path }, logger);
    const tools = new ToolRegistry();
    // 传 getter 而不是 `plugins.list()` 的结果：此刻还没 `loadAll()`，而且插件能在运行期
    // 增删与启停，快照会让这颗工具继续说出装配那一刻的事实。
    const plugins = new PluginManager(pluginRuntimeConfig(config), logger, {
      // 每个配置档自己的插件数据根。安装是全局的（`config.pluginDirs`），所以同一个插件 id
      // 会在每份档里各出现一次 —— 数据根不分家的话，两份档的同一个插件会互相覆写 token。
      dataRoot: join(profileDir(profilesDir, id), "plugins"),
      disabledIds: disabledPluginsOf(profile),
      // 启用状态写回**这份档**的文件。注入而不是让 `plugins/` 去 import 配置写入器：
      // 分层规则没有检查在守这一条边，而 `list_plugins` 收访问器已经是仓内先例。
      persistEnabled: (pluginId, enabled) => setProfilePluginEnabled(path, pluginId, enabled),
      // 「建插件数据目录并收到 0700」也走注入：`plugins/` 只依赖注入给它的 ctx，
      // 不去 import `config/` 里那个会动文件系统的实现。与上面 `persistEnabled` 同一形状。
      ensurePrivateDir,
    });
    for (const tool of createBuiltinTools({
      // **在装配处投影**，而不是把 `plugins.list()` 直接递过去：那份是 `PluginView`，
      // 含插件所在目录与上一次加载的原文（第三方文本，可能带绝对路径），
      // 而工具结果整段要发给第三方 provider。类型上 `listPlugins` 只声明读那几个键，
      // 运行时交出去的现实却由那个对象决定 —— 「窄的类型标注不等于窄的现实」（AGENTS.md）。
      listPlugins: () =>
        plugins.list().map((p) => ({
          id: p.id,
          name: p.name,
          enabled: p.enabled,
          failed: p.error !== null,
        })),
    })) {
      tools.register(tool);
    }
    const engine = new AgentEngine({
      sessions,
      providers,
      tools,
      toolConfig,
      logger,
      lock,
      events,
      profileId: id,
      defaultProviderId,
    });
    return {
      id,
      name: profile.name ?? id,
      path,
      defaultProviderId,
      tools,
      toolConfig,
      plugins,
      engine,
    };
  }

  /**
   * 构造 + 加载插件 + 登记。失败时把这一条登记成 `failed` 并**不抛**。
   *
   * 「一颗坏了不拖垮别人」在本仓已有两处先例（`PluginManager.#scanDir` 的逐条 try/catch、
   * `createProviders` 的 per-item errors），这里是第三处：一份读坏了的配置档不该让
   * 整个进程起不来 —— 部署级文件坏掉才是启动即死，那下面没有可退的东西。
   *
   * `plugins.loadAll()` 排在登记**之后**：加载插件时 `ctx.plugins()` 要能看见同档的同伴。
   */
  async function openProfile(id: string): Promise<ProfileBundle | null> {
    let bundle: ProfileBundle;
    try {
      bundle = await buildBundle(id);
    } catch (err) {
      states.set(id, {
        name: id,
        status: "failed",
        error: errorMessage(err),
        defaultProviderId: null,
      });
      logger.error(`配置档「${id}」加载失败: ${errorMessage(err)}`);
      return null;
    }
    bundles.set(id, bundle);
    states.set(id, readyState(bundle));
    await bundle.plugins.loadAll();
    return bundle;
  }

  /**
   * 卸载并摘掉一份配置档。**不删文件、不删它的插件数据目录**。
   *
   * 摘登记必须**无条件**发生。`failed` 的档在 `bundles` 里根本没有条目（`openProfile` 的
   * catch 只往 `states` 写了一条），所以「拿不到 bundle 就早退」会让那条登记永远留在目录里：
   * 症状是 `DELETE /profiles/:id` 回 200 `{removed:true}`，刷新之后它还在，
   * 而指向它的作用域请求照旧不可用 —— 回成功、界面回到原样，是本仓最恨的一种形状。
   */
  async function closeProfile(id: string): Promise<void> {
    const bundle = bundles.get(id);
    bundles.delete(id);
    states.delete(id);
    await bundle?.plugins.unloadAll();
  }

  // 装配**必须早于任何一份档**：`buildBundle()` 里那句「这一档的默认 provider 有没有
  // 加载成功」要看注册表此刻的内容，早于装配就会对每一条档误报一次。
  // 少这一句的后果不是报错而是静默降级 —— 注册表空着，每条消息都落到回声兜底，
  // 而 `GET /providers` 照旧显示「已配置」（它读的是配置文件，不是注册表）。
  rebuildProviders();

  for (const id of listProfileDirs(profilesDir)) {
    await openProfile(id);
  }
  // 至少有一份配置档：`seedProfile` 保证了 `default` 的文件存在，但如果它读不出来
  //（操作者手改坏了 JSON），这里补一条明确的说法，而不是让界面面对一个空列表。
  if (bundles.size === 0 && states.size === 0) {
    await openProfile(DEFAULT_PROFILE_ID);
  }

  const profiles: ProfileDirectory = {
    ids: () => [...states.keys()].toSorted(),
    get: (id) => bundles.get(id) ?? null,
    status: (id) => states.get(id)?.status ?? null,
    records: (): ProfileRecord[] =>
      [...states.entries()]
        .map(([id, state]) => ({
          id,
          name: state.name,
          path: profileConfigPath(profilesDir, id),
          status: state.status,
          error: state.error,
          defaultProviderId: state.defaultProviderId,
        }))
        .toSorted((a, b) => (a.id < b.id ? -1 : 1)),
    async create(id, name) {
      assertProfileId(id);
      const path = profileConfigPath(profilesDir, id);
      if (existsSync(path)) throw new Error(`配置档「${id}」已经存在`);
      // 先落盘再建对象图：崩在中间的话文件在那儿、档是 failed，操作者看得见并可重载；
      // 反过来的话一个没人知道的内存对象会先存在过。
      writeProfileConfig(path, name === undefined ? {} : { name });
      const bundle = await openProfile(id);
      if (!bundle) throw new Error(`配置档「${id}」已创建，但加载失败：${states.get(id)?.error}`);
      return recordOf(id);
    },
    async rename(id, name) {
      assertProfileId(id);
      const path = profileConfigPath(profilesDir, id);
      const profile = readProfileConfig(path);
      profile.name = name;
      writeProfileConfig(path, profile);
      const bundle = bundles.get(id);
      if (bundle) {
        bundle.name = name;
        states.set(id, readyState(bundle));
      } else {
        const state = states.get(id);
        if (state) states.set(id, { ...state, name });
      }
      return recordOf(id);
    },
    /**
     * 改这一档默认用的 provider 实例。
     *
     * 先验「这个实例在全局清单里存在」再落盘：让它指着一个不存在的 id，症状不是报错而是
     * 每条消息静默落到注册表的回退上 —— 界面显示你选了 A，回的却是全局默认那个。
     * 与 `rename` 一样**先落盘再动内存**，那样一次写失败留下的是自洽的状态。
     */
    async setDefaultProvider(id, providerId) {
      assertProfileId(id);
      if (!states.has(id)) throw new ApiError(`没有这份配置档: ${id}`, 404);
      if (providerId !== null && providerConfig.getProvider(providerId) === null) {
        throw new ApiError(
          `全局供应商清单里没有 provider「${providerId}」，不能把它设成这份配置档的默认`,
          400,
        );
      }
      updateProfileConfig(profileConfigPath(profilesDir, id), (file) => {
        // `null` 是「取消档级默认，回到全局那一个」，所以删掉键而不是留一个空串：
        // 留着 `"defaultProvider": ""` 会让下一次读它的人判断两次。
        if (providerId === null) delete file.defaultProvider;
        else file.defaultProvider = providerId;
      });
      const bundle = bundles.get(id);
      if (bundle) {
        bundle.defaultProviderId = providerId;
        // 引擎上那份才是发消息时真正读的那一个：只改 bundle 会得到「界面已经改了，
        // 下一条消息还是老模型」，而要等一次重载才生效这件事没有任何地方会说。
        bundle.engine.defaultProviderId = providerId;
      }
      const state = states.get(id);
      if (state) states.set(id, { ...state, defaultProviderId: providerId });
      return recordOf(id);
    },
    async reload(id) {
      assertProfileId(id);
      const previous = bundles.get(id);
      let next: ProfileBundle;
      try {
        next = await buildBundle(id);
      } catch (err) {
        // 新的建不起来：**保留正在服务的那一份**，只把状态说成失败。
        // 换上一个半截的对象图比继续用旧配置危险得多（旧的那份至少是在工作的）。
        states.set(id, {
          name: previous?.name ?? id,
          status: "failed",
          error: errorMessage(err),
          defaultProviderId: previous?.defaultProviderId ?? null,
        });
        throw new Error(`配置档「${id}」重载失败，仍在使用重载前的对象图：${errorMessage(err)}`, {
          cause: err,
        });
      }
      if (previous) {
        bundles.set(id, next);
        states.set(id, readyState(next));
        await previous.plugins.unloadAll();
      } else {
        await closeProfile(id);
        bundles.set(id, next);
        states.set(id, readyState(next));
      }
      await next.plugins.loadAll();
      return recordOf(id);
    },
    async remove(id) {
      assertProfileId(id);
      // 占用检查与摘除之间不能有 await：否则一次新对话可以恰好插进这两步之间，
      // 拿到一份马上要被删掉的对象图。`lock.isInUse` 与 `bundles.delete` 都是同步的，
      // 所以这一段在单线程里不可打断 —— 与会话锁本身的正确性依赖同一条性质。
      if (lock.isInUse(id)) return false;
      await closeProfile(id);
      return true;
    },
  };

  function recordOf(id: string): ProfileRecord {
    const found = profiles.records().find((r) => r.id === id);
    if (!found) throw new Error(`配置档「${id}」不在目录里`);
    return found;
  }

  // 适配器按绑定取那一跑法。注入访问器而不是 `profiles` 本身：`adapters/` 按分层不得
  // import `api/`，而 `ProfileDirectory` 与 `ProfileBundle` 就声明在那里。
  const adapters = new AdapterManager({
    config,
    logger,
    resolveProfile: (id) => {
      const bundle = profiles.get(id);
      return bundle === null ? null : { engine: bundle.engine };
    },
  });

  const http = createHttpServer({
    config,
    logger,
    version: readServerVersion(),
    auth,
    sessions,
    lock,
    events,
    profiles,
    providerSurface,
    adapters,
  });

  await adapters.startAll();

  return {
    async start() {
      await http.listen(config.port, config.host);
      // 用真实端口打印：config.port 可能是 0。
      logger.info(`atri-bot 正在监听 http://${config.host}:${http.address().port}`);
    },
    // 暴露监听地址，让 port: 0（随机端口）的调用方能拿到真实端口。
    address: () => http.address(),
    // 真实注册的 API 路由，供测试比对 openapi.json。
    routes: () => http.routes(),
    /**
     * 事件总线此刻的订阅者数量。存在的唯一理由是关停断言：`http.close()` 必须退掉它那一个
     * 订阅，漏掉的后果是一个闭包长期挂着已死的连接集合 —— 而那在功能上完全隐形
     *（没有 WebSocket 连着就什么都不发），所以这是它唯一会被看见的时刻。
     * 与 `routes()` 是同一种出口：为检查而存在，不参与任何业务判定。
     */
    listeners: () => events.listenerCount,
    async stop() {
      await adapters.stopAll();
      await http.close();
      // 每一档都要卸：`unloadAll()` 是插件实例的 `teardown()` 的唯一调用点，
      // 漏掉一份就等于留着它的监听器与连接。
      for (const bundle of bundles.values()) {
        await bundle.plugins.unloadAll();
      }
      // 库排在最后关：`http.close()` 先掐掉在途的 SSE 与 WS，那一刻之后不应再有新的写库请求；
      // 插件的 teardown 理论上也可能触发写（今天 ctx 里没有会话句柄，排在后面才对未来也成立）。
      sessions.close();
    },
  };
}
