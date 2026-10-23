import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, LogStore } from "./core/logger.ts";
import { AgentEngine } from "./core/agent/engine.ts";
import { SessionEvents } from "./core/agent/events.ts";
import { PersonaStore } from "./core/persona/store.ts";
import { CronScheduler } from "./core/cron/manager.ts";
import { CronStore } from "./core/cron/store.ts";
import { SessionLock } from "./core/session/lock.ts";
import { SessionManager } from "./core/session/manager.ts";
import { ProviderRegistry } from "./core/provider/registry.ts";
import { createProviders, readDefaultProviderId } from "./core/provider/factory.ts";
import { ProviderConfigStore } from "./core/provider/store.ts";
import { ToolRegistry } from "./core/tool/registry.ts";
// 上下界只写一处（见 `core/tool/store.ts` 那条注释）：这里拿它做**写入**的校验，
// 而同一对数字在读文件时用来夹取 —— 两种用法刻意不同，判据也写在那儿。
import { MAX_MAX_TOOL_STEPS, MIN_MAX_TOOL_STEPS, ToolConfigStore } from "./core/tool/store.ts";
import { createBuiltinTools } from "./core/tool/builtins.ts";
import { AuthManager } from "./core/auth/manager.ts";
import { ApiError, errorMessage } from "./core/errors.ts";
import { PluginManager, pluginRuntimeConfig } from "./plugins/manager.ts";
import { AdapterManager } from "./adapters/manager.ts";
import type { Adapter, AdapterTarget } from "./adapters/manager.ts";
import { AdapterConfigStore } from "./adapters/store.ts";
import type { AdapterEntryConfig } from "./adapters/store.ts";
import { JsonConversationSessions } from "./adapters/conversations.ts";
import { NapCatAdapter } from "./adapters/napcat.ts";
import { SnowLumaAdapter } from "./adapters/snowluma.ts";
import { ADAPTER_TYPES } from "./adapters/templates.ts";
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
  readConfigFileAt,
  writeConfigFileAt,
} from "./config/file.ts";
import type { ProvidersFileConfig, ProviderSourceEntryConfig } from "./config/file.ts";
import {
  DEFAULT_PROFILE_ID,
  assertProfileId,
  emptyAccess,
  listProfileDirs,
  migrateProvidersToGlobal,
  normalizeAccess,
  profileConfigPath,
  profileDir,
  profilesRoot,
  providerShapeKeysIn,
  readProfileConfig,
  removeProfileDir,
  runShapeKeysIn,
  seedProfile,
  setProfilePluginEnabled,
  updateProfileConfig,
  validateAccess,
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

/**
 * `POST /profiles/{id}/config` 能改的顶层键。**白名单而不是黑名单**：
 * 放任意键进来就等于把这份档文件开成一台远程编辑器 —— 它能改写残留的 `providers` 段
 *（那是已经全局化的死键，写回去就又有两个真源），也能塞进任何我们不认识的东西。
 * 秘密会换名字、会新增，黑名单每一次都迟到（AGENTS.md 里插件白名单那条同判据）。
 */
const PROFILE_PATCH_KEYS = [
  "defaultProvider",
  "personaId",
  "maxToolSteps",
  "tools",
  "plugins",
  "access",
] as const;

/**
 * 把 `{ "<id>": { enabled: boolean } }` 那一段验成一张可应用的清单。
 *
 * `label` 是错误文案里的名词（工具 / 插件）：拒掉一个不存在的开关时，
 * 「不存在」必须说得出是**哪一族**不存在，否则用户去翻错的那一页。
 */
function asToggles(
  value: unknown,
  section: string,
  label: string,
  exists: (id: string) => boolean,
): [string, boolean][] {
  if (value === undefined) return [];
  // 形状判据与 HTTP 入口那条一致：非 null、是对象、不是数组。
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(`\`${section}\` 必须是一个对象（键是 ${label} id）`, 400);
  }
  const out: [string, boolean][] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!exists(key)) {
      throw new ApiError(
        `${label}「${key}」不存在，改不了一个不存在的开关（${section} 段的键必须是 ${label} id）`,
        400,
      );
    }
    const enabled =
      raw !== null && typeof raw === "object" ? (raw as { enabled?: unknown }).enabled : raw;
    if (typeof enabled !== "boolean") {
      throw new ApiError(`${label}「${key}」的 \`enabled\` 必须是布尔值`, 400);
    }
    out.push([key, enabled]);
  }
  return out;
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
  // 先建缓冲区、再建 logger：启动阶段的日志（seed、插件加载）也要能被日志页看到，
  // 而那时 HTTP 服务还没构造。顺序反过来会丢掉启动日志，且没有任何报错。
  const logs = new LogStore();
  const logger = createLogger(config.logLevel, logs);

  /**
   * 适配器管理器晚于配置档装配：它需要 `resolveProfile`，而配置档在 `buildBundle`
   * 时就要创建插件管理器。插件在 `setup()` 里调用 `ctx.adapters()` 时这里还是 null，
   * 所以动作端口用**晚绑定**——运行期再读，不在装配时抓快照。
   */
  let adapterRuntime: AdapterManager | null = null;

  function adapterActionsFor(profileId: string) {
    return {
      list: () =>
        (adapterRuntime?.list() ?? [])
          .filter((adapter) => adapter.profile === profileId)
          .map((adapter) => ({
            id: adapter.id,
            name: adapter.name,
            type: adapter.type,
            running: adapter.running,
          })),
      call: async (adapterId: string, action: string, params: Record<string, unknown>) => {
        if (adapterRuntime === null) throw new Error("适配器管理器尚未就绪");
        const result = await adapterRuntime.callAction(adapterId, action, params, profileId);
        if (!result.ok) throw new Error(result.error ?? "接入平台动作失败");
        return result.data;
      },
    };
  }

  const auth = new AuthManager(config, logger);
  // 必须早于 HTTP 服务启动：未配置口令时要先把随机口令写进配置文件。
  await auth.init();

  // 会话与消息落在 `config.dataDir` 下的 sqlite（建库与 schema 升级见 `core/session/db.ts`）。
  const sessions = new SessionManager(config, logger);
  const lock = new SessionLock();
  const events = new SessionEvents();
  const personas = new PersonaStore({ filePath: join(config.dataDir, "personas.json"), logger });

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
   * `openProfile` 先用它建好、成功之后才登记，失败时只留一条 `failed` 记录 ——
   * 这样一个半截的对象图不会先出现在 Maps 里。
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
    const personaId =
      typeof profile.personaId === "string" && profile.personaId ? profile.personaId : null;
    const access = normalizeAccess(profile.access, () => {
      logger.warn(
        `配置档「${id}」的 access 段格式不正确，已按「白名单拒绝、仅管理员放行」处理；` +
          `修好 ${path} 或重新保存一次配置即可恢复`,
      );
    });
    if (personaId !== null && personas.get(personaId) === null) {
      logger.warn(`配置档「${id}」引用的人格「${personaId}」不存在，本轮起不注入人格提示`);
    }
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
      // 插件自己的 `config.json` 的读与写。同样注入：这一层只负责「配置属于谁」，
      // 原子写与 0600 的细节留在 `config/file.ts` 一处。
      readConfigFileAt,
      writeConfigFileAt,
      // 按档过滤的动作端口：插件只能操作绑定到这份档的适配器。
      adapterActions: adapterActionsFor(id),
    });
    for (const tool of createBuiltinTools()) tools.register(tool);
    // 插件工具走动态来源：插件重载/禁用后下一轮请求立刻看到新清单，
    // 不需要在每次启停时重建工具注册表。
    tools.registerSource(() => plugins.tools());
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
      systemPrompt: personas.promptFor(personaId),
    });
    return {
      id,
      name: profile.name ?? id,
      path,
      defaultProviderId,
      personaId,
      access,
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
      if (existsSync(path)) throw new Error(`配置「${id}」已经存在`);
      // 先落盘再建对象图：崩在中间的话文件在那儿、档是 failed，操作者看得见；
      // 反过来的话一个没人知道的内存对象会先存在过。
      writeProfileConfig(path, name === undefined ? {} : { name });
      const bundle = await openProfile(id);
      if (!bundle) throw new Error(`配置「${id}」已创建，但加载失败：${states.get(id)?.error}`);
      return recordOf(id);
    },
    /**
     * 改这一档默认用的 provider 实例。
     *
     * 先验「这个实例在全局清单里存在」再落盘：让它指着一个不存在的 id，症状不是报错而是
     * 每条消息静默落到注册表的回退上 —— 界面显示你选了 A，回的却是全局默认那个。
     * **先落盘再动内存**，那样一次写失败留下的是自洽的状态。
     */
    async setDefaultProvider(id, providerId) {
      assertProfileId(id);
      if (!states.has(id)) throw new ApiError(`没有这份配置: ${id}`, 404);
      // 用**注册表**而不是配置文件判：配置里写着但没加载成功/已禁用的实例，选它只会让
      // 每条消息静默回退到别的 provider。界面必须立刻拿到 400。
      if (providerId !== null && providers.get(providerId) === null) {
        throw new ApiError(
          `全局供应商清单里没有 provider「${providerId}」，或它未加载成功/已禁用，不能把它设成这份配置的默认`,
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
    /**
     * 一次写入这份档的多段配置（配置工作台的「保存」）。
     *
     * 三条判据都不是风格：
     *
     * - **先全部验完，再动磁盘**。一半改成功、一半因为笔误失败，留下的是「界面上配好了、
     *   实际跑的是一套混合状态」，而那种状态只能靠猜来排查。宁可整批不写。
     * - **顶层键白名单**（见 `PROFILE_PATCH_KEYS`）。
     * - **插件那一段走管理器**，不并进那一次文件写入：`setEnabled` 会真的加载/卸载那颗
     *   插件并自己落盘，绕过它写文件会得到「文件说开了、运行态没跑」。它可能中途失败
     *   （`setup()` 抛错），那时前面几颗已经生效 —— 那种时刻如实回 `failed[]`。
     *
     * 被否掉的两种做法，写下来免得被重新发明：**① 写完重建整张对象图**（`buildBundle`）
     * —— 那会给每颗插件重新求值（带 cache-busting 的 import）并把正在跑的插件
     * `unloadAll()`，代价远大于逐颗 `setEnabled`；**② 因为这份档占着某个会话就拒绝保存**
     * —— 与 `remove()` 不同，这里什么都不拆：`tools` 与 `maxToolSteps` 是**每轮现读**
     *（`AgentEngine.#declaredTools` / `maxSteps()`），在跑的那一轮继续用它自己那份视图，
     * 下一条消息才用新的。
     */
    async updateConfig(id, body) {
      assertProfileId(id);
      for (const key of Object.keys(body)) {
        if (!(PROFILE_PATCH_KEYS as readonly string[]).includes(key)) {
          throw new ApiError(
            `不认识的配置段「${key}」，能改的只有 ${PROFILE_PATCH_KEYS.join(" / ")}`,
            400,
          );
        }
      }
      if (!states.has(id)) throw new ApiError(`没有这份配置: ${id}`, 404);
      const bundle = bundles.get(id);
      if (!bundle) {
        // failed 的档没有对象图，也就没有「这套开关属于哪张注册表」可说；
        // 原因由 `GET /profiles` 的 `error` 给操作者（那句里带绝对路径）。
        throw new ApiError(`配置「${id}」当前不可用，原因见 GET /profiles`, 503);
      }

      // 校验一次做完，并把**收窄后的值**留成局部量：下面那段读-改-写里再对
      // `body.xxx` 做 typeof 判断的话，编译器与读代码的人都得跟着判第二遍。
      let nextPersona: string | null | undefined;
      if (body.personaId !== undefined) {
        const value: unknown = body.personaId;
        if (typeof value !== "string" && value !== null) {
          throw new ApiError("`personaId` 必须是字符串或 null", 400);
        }
        if (value !== null && personas.get(value) === null) {
          throw new ApiError(`人格库中没有「${value}」，不能把它设成这份配置的人格`, 400);
        }
        nextPersona = value;
      }

      let nextDefault: string | null | undefined;
      if (body.defaultProvider !== undefined) {
        const value: unknown = body.defaultProvider;
        if (typeof value !== "string" && value !== null) {
          throw new ApiError("`defaultProvider` 必须是字符串或 null", 400);
        }
        if (value !== null && providers.get(value) === null) {
          // 与 `setDefaultProvider` 同一句判据：让它指着一个不存在、未加载或已禁用的实例，
          // 症状不是报错而是每条消息静默落到注册表的回退上 —— 界面显示你选了 A，回的却是别的。
          throw new ApiError(
            `全局供应商清单里没有 provider「${value}」，或它未加载成功/已禁用，不能把它设成这份配置的默认`,
            400,
          );
        }
        nextDefault = value;
      }

      let nextSteps: number | undefined;
      if (body.maxToolSteps !== undefined) {
        const value: unknown = body.maxToolSteps;
        if (typeof value !== "number" || !Number.isInteger(value)) {
          throw new ApiError("`maxToolSteps` 必须是整数（单轮允许的工具步数）", 400);
        }
        if (value < MIN_MAX_TOOL_STEPS || value > MAX_MAX_TOOL_STEPS) {
          // **不夹取**：给请求夹值等于「你要 999 我只存 50 且不说」，而界面上那个 999
          // 会变成一句谎。读文件时夹是另一件事（手写的配置不该让服务起不来）。
          throw new ApiError(
            `maxToolSteps 必须在 ${MIN_MAX_TOOL_STEPS} 到 ${MAX_MAX_TOOL_STEPS} 之间`,
            400,
          );
        }
        nextSteps = value;
      }

      const tools = asToggles(body.tools, "tools", "工具", (tid) => {
        const tool = bundle.tools.get(tid);
        // 内部工具由引擎无条件声明，不进入用户开关；允许写进来只会制造一个永远不会生效的键。
        return tool !== null && tool.internal !== true;
      });
      const plugins = asToggles(
        body.plugins,
        "plugins",
        "插件",
        (pid) => bundle.plugins.get(pid) !== null,
      );

      let nextAccess: ReturnType<typeof validateAccess> | undefined;
      if (body.access !== undefined) nextAccess = validateAccess(body.access);

      // --- 到这里全部验完了，下面才开始动磁盘与运行态 -----------------------
      if (
        nextDefault !== undefined ||
        nextPersona !== undefined ||
        nextSteps !== undefined ||
        nextAccess !== undefined ||
        tools.length > 0
      ) {
        updateProfileConfig(profileConfigPath(profilesDir, id), (file) => {
          if (nextPersona !== undefined) {
            if (nextPersona === null) delete file.personaId;
            else file.personaId = nextPersona;
          }
          if (nextDefault !== undefined) {
            // `null` 是「取消档级默认」，删键而不是留空串：留着 `""` 会让下一次读它的人判断两次。
            if (nextDefault === null) delete file.defaultProvider;
            else file.defaultProvider = nextDefault;
          }
          if (nextSteps !== undefined) file.maxToolSteps = nextSteps;
          if (nextAccess !== undefined) file.access = nextAccess;
          for (const [tid, enabled] of tools) {
            const current = file.tools ?? {};
            // 展开保留这一段里我们不认识的键（`ToolToggle` 是开放类型，与插件段同一条理由）。
            current[tid] = { ...current[tid], enabled };
            file.tools = current;
          }
        });
      }
      if (nextDefault !== undefined) {
        bundle.defaultProviderId = nextDefault;
        // 引擎上那份才是发消息时真正读的那一个：只改 bundle 会得到「界面已经改了，
        // 下一条消息还是老模型」。
        bundle.engine.defaultProviderId = nextDefault;
        const state = states.get(id);
        if (state) states.set(id, { ...state, defaultProviderId: nextDefault });
      }
      if (nextPersona !== undefined) {
        bundle.personaId = nextPersona;
        bundle.engine.systemPrompt = personas.promptFor(nextPersona);
      }
      if (nextAccess !== undefined) {
        // 适配器的 `resolveAccess` 每次收到消息都读 bundle 上的这一份；
        // 所以改完这里，下一条消息就是新名单，不需要重启长连接。
        bundle.access = nextAccess;
      }

      const failed: { id: string; error: string }[] = [];
      for (const [pid, enabled] of plugins) {
        try {
          await bundle.plugins.setEnabled(pid, enabled);
        } catch (err) {
          // 不中断：后面那些开关是用户在同一批里明确要改的，一颗插件起不来
          // 不该让它们全部不回。每一条都点名，界面按条标红。
          failed.push({ id: pid, error: errorMessage(err) });
        }
      }
      return { failed };
    },
    async reload(id) {
      assertProfileId(id);
      if (!states.has(id)) throw new ApiError(`没有这份配置: ${id}`, 404);
      if (lock.isInUse(id)) {
        throw new ApiError("这份配置正被会话使用，等那一轮对话结束后再重载", 409);
      }
      await closeProfile(id);
      // `openProfile` 失败时会把这一档登记成 failed，返回的记录仍然要带上原因；
      // 这一档的旧插件实例已经在 closeProfile 里卸掉，不能假装还能回滚。
      await openProfile(id);
      logger.info(`配置档已重载: ${id}`);
      return recordOf(id);
    },
    async remove(id) {
      assertProfileId(id);
      // 占用检查与摘除之间不能有 await：否则一次新对话可以恰好插进这两步之间，
      // 拿到一份马上要被删掉的对象图。`lock.isInUse` 与 `bundles.delete` 都是同步的，
      // 所以这一段在单线程里不可打断 —— 与会话锁本身的正确性依赖同一条性质。
      if (lock.isInUse(id)) return false;
      await closeProfile(id);
      // 先摘后删：`closeProfile` 里的 `unloadAll()` 会 await，失败时它会抛出，
      // 那时磁盘必须一个字节都没动。走到这里说明服务已经不认识这份档了，
      // 它自己的目录（config.json + plugins 数据）才跟着消失。
      removeProfileDir(profilesDir, id);
      return true;
    },
    clearDefaultProviders(providerIds) {
      const targets = new Set(providerIds);
      const cleared: string[] = [];
      for (const id of states.keys()) {
        const path = profileConfigPath(profilesDir, id);
        const bundle = bundles.get(id);
        let fileRef: string | undefined;
        try {
          const file = readProfileConfig(path);
          if (typeof file.defaultProvider === "string") fileRef = file.defaultProvider;
        } catch {
          // 坏文件已经没有可坚持的引用；运行态若是 ready 仍按 bundle 清。
        }
        const runtimeRef = bundle?.defaultProviderId ?? null;
        const stateRef = states.get(id)?.defaultProviderId ?? null;
        if (
          (fileRef === undefined || !targets.has(fileRef)) &&
          !targets.has(runtimeRef ?? "") &&
          !targets.has(stateRef ?? "")
        ) {
          continue;
        }
        if (fileRef !== undefined && targets.has(fileRef)) {
          try {
            updateProfileConfig(path, (file) => {
              if (typeof file.defaultProvider === "string" && targets.has(file.defaultProvider)) {
                delete file.defaultProvider;
              }
            });
          } catch (err) {
            logger.error(`清除配置档「${id}」的 provider 默认引用失败: ${errorMessage(err)}`);
            // 文件没改成，但运行态仍必须立刻停止使用一个已经被删掉的 provider；
            // 文件里的旧引用只能等操作者修好写权限后再保存/手工清理。
          }
        }
        if (bundle && runtimeRef !== null && targets.has(runtimeRef)) {
          bundle.defaultProviderId = null;
          // 引擎才是发消息时真正读的那一个；只改 bundle 会留下「界面没了默认、
          // 下一条消息还打旧模型」的错位。
          bundle.engine.defaultProviderId = null;
        }
        const state = states.get(id);
        if (state && state.defaultProviderId !== null && targets.has(state.defaultProviderId)) {
          states.set(id, { ...state, defaultProviderId: null });
        }
        cleared.push(id);
      }
      return cleared.toSorted();
    },
  };

  function recordOf(id: string): ProfileRecord {
    const found = profiles.records().find((r) => r.id === id);
    if (!found) throw new Error(`配置档「${id}」不在目录里`);
    return found;
  }

  /** 人格内容改了之后同步所有正在运行、且引用了它的引擎。 */
  function syncPersonaPrompts(): void {
    for (const bundle of bundles.values()) {
      bundle.engine.systemPrompt = personas.promptFor(bundle.personaId);
    }
  }

  /** 哪些配置档引用了这份人格。删除人格前用它挡住悬空引用（含暂时加载失败的档）。 */
  function personaUsage(personaId: string): string[] {
    const users = new Set<string>();
    for (const id of profiles.ids()) {
      const bundle = bundles.get(id);
      if (bundle !== undefined) {
        if (bundle.personaId === personaId) users.add(id);
        continue;
      }
      // failed 的档没有对象图，但文件里仍可能写着引用；删人格前也应把它算进来。
      try {
        const file = readProfileConfig(profileConfigPath(profilesDir, id));
        if (file.personaId === personaId) users.add(id);
      } catch {
        /* 文件本身坏掉的档不参与引用判断，修好后会按缺失人格告警 */
      }
    }
    return [...users].toSorted();
  }

  const cronStore = new CronStore({ filePath: join(config.dataDir, "cron.json"), logger });
  const scheduler = new CronScheduler({
    store: cronStore,
    logger,
    sessions,
    resolveEngine: (profileId) => profiles.get(profileId)?.engine ?? null,
  });

  // 适配器按绑定取那一跑法。注入访问器而不是 `profiles` 本身：`adapters/` 按分层不得
  // import `api/`，而 `ProfileDirectory` 与 `ProfileBundle` 就声明在那里。
  const resolveProfile = (id: string): AdapterTarget | null => {
    const bundle = profiles.get(id);
    return bundle === null ? null : { engine: bundle.engine };
  };

  /*
   * 适配器实例现在住在**运行期**的 data/adapters.json：控制台可以新增/删除/启停，
   * 不再要求用户改 atri.config.json。旧文件里的 adapters 段只在运行期文件不存在时
   * 迁移一次；之后它不再生效（下面会打日志说清）。
   */
  const adapterIo = {
    exists: existsSync,
    ensureDir: ensurePrivateDir,
    read: readConfigFileAt,
    write: writeConfigFileAt,
  };
  const adapterStore = new AdapterConfigStore({
    filePath: join(config.dataDir, "adapters.json"),
    seed: config.adapters,
    logger,
    io: adapterIo,
  });
  if (adapterStore.source === "seed") {
    logger.info(
      "已把 atri.config.json 的 adapters 搬进 data/adapters.json；以后在控制台「接入平台」页维护",
    );
  } else if (adapterStore.source === "file" && Object.keys(config.adapters).length > 0) {
    logger.warn("adapters 已由 data/adapters.json 管理，atri.config.json 的 adapters 段不再生效");
  }

  /*
   * 类型分派留在组合根：管理器只认识模板与 `Adapter`，不认识 NapCat。
   * 每个实例有自己的会话映射文件 data/adapters/<id>/sessions.json（0700/0600），
   * 里面只有「外部会话 → 内部会话 id」，不含消息内容与凭证。
   */
  const createAdapter = (id: string, entry: AdapterEntryConfig): Adapter => {
    const conversations = new JsonConversationSessions({
      filePath: join(config.dataDir, "adapters", id, "sessions.json"),
      sessions,
      logger,
      io: {
        ensureDir: ensurePrivateDir,
        read: readConfigFileAt,
        write: writeConfigFileAt,
      },
    });
    const common = {
      id,
      profileId: entry.profile,
      logger,
      resolveTarget: resolveProfile,
      conversations,
      // 名单属于配置档，不属于平台实例：每收到一条消息现读绑定档的那一份，
      // 所以保存档里的 access 后下一条消息就生效，不必重启适配器。
      resolveAccess: () => profiles.get(entry.profile)?.access ?? emptyAccess(),
    };
    switch (entry.type) {
      case ADAPTER_TYPES.napcat:
        return new NapCatAdapter({
          ...common,
          host: entry.settings.host ?? "",
          port: entry.settings.port ?? "",
          path: entry.settings.path ?? "",
          token: entry.settings.token ?? "",
        });
      case ADAPTER_TYPES.snowluma:
        return new SnowLumaAdapter({
          ...common,
          url: entry.settings.url ?? "",
          token: entry.settings.token ?? "",
        });
      default:
        throw new Error(`未知适配器类型：${entry.type}`);
    }
  };
  const adapters = new AdapterManager({
    store: adapterStore,
    logger,
    resolveProfile,
    createAdapter,
    // 适配器的会话映射在 `data/adapters/<id>/sessions.json`；删除实例时连目录一起清。
    // 已存在的内部会话本身留在全局 sqlite 里（它们可能还被控制台直接打开），只清映射。
    removeAdapterState: (id) => {
      rmSync(join(config.dataDir, "adapters", id), { recursive: true, force: true });
    },
  });
  adapterRuntime = adapters;

  const http = createHttpServer({
    config,
    logger,
    logs,
    version: readServerVersion(),
    auth,
    sessions,
    lock,
    events,
    profiles,
    providerSurface,
    adapters,
    personas,
    onPersonasChanged: syncPersonaPrompts,
    personaUsage,
    scheduler,
  });

  await adapters.startAll();
  scheduler.start();

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
      scheduler.stop();
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
