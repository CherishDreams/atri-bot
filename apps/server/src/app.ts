import { existsSync } from "node:fs";
import { join } from "node:path";
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
import { errorMessage } from "./core/errors.ts";
import { PluginManager, pluginRuntimeConfig } from "./plugins/manager.ts";
import { AdapterManager } from "./adapters/manager.ts";
import { createHttpServer } from "./api/server.ts";
import type { ProfileBundle, ProfileDirectory } from "./api/http.ts";
import type { AppConfig } from "./config/index.ts";
import {
  configFilePath,
  ensurePrivateDir,
  ensurePrivateFile,
  readConfigFile,
} from "./config/file.ts";
import {
  DEFAULT_PROFILE_ID,
  assertProfileId,
  listProfileDirs,
  profileConfigPath,
  profileDir,
  profilesRoot,
  readProfileConfig,
  runShapeKeysIn,
  seedProfile,
  setProfilePluginEnabled,
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

/** 一份配置档在目录里的状态（成功的那些也在这里，为的是 `records()` 一次算完）。 */
interface ProfileState {
  name: string;
  status: ProfileStatus;
  error: string | null;
}

/**
 * 组合根（composition root）：唯一知道各部件如何拼装的地方。
 * 下层通过构造函数注入协作者，彼此互不感知，
 * 从而让 core/ 不掺杂任何传输层细节。
 *
 * ## 现在这里拼装的是「N 份对象图」
 *
 * 一份配置档 = 一套 `ProviderRegistry` / `ProviderConfigStore` / `ToolConfigStore` /
 * `ToolRegistry` / `PluginManager` / `AgentEngine`。跨配置档共享的只有四样：
 * 登录、会话存储、**会话锁**、**事件总线**。后两个必须是共享的，理由写在
 * `core/session/lock.ts` 与 `core/agent/events.ts` 各自的类注释里 —— 一句话版本：
 * 历史是全局一份 sqlite，而「同一个会话不能同时跑两轮」不是任何单个配置档的内部事务。
 */
export async function createApp(config: AppConfig) {
  const logger = createLogger(config.logLevel);

  const auth = new AuthManager(config, logger);
  // 必须早于 HTTP 服务启动：未配置口令时要先把随机口令写进配置文件。
  await auth.init();

  // 会话与消息落在 `config.dataDir` 下的 sqlite（建库与 schema 升级见 `core/session/db.ts`）。
  const sessions = new SessionManager(config, logger);
  const lock = new SessionLock();
  const events = new SessionEvents();

  // 「跑法」住在配置档文件里，不在 `atri.config.json`。顺序是有意的：先建目录、
  // 再一次性 seed、**然后**才构造任何对象图 —— 存储拿到的一直是配置档路径。
  const profilesDir = profilesRoot(config.dataDir);
  ensurePrivateDir(profilesDir);
  const seedPath = profileConfigPath(profilesDir, DEFAULT_PROFILE_ID);
  const bootstrap = readConfigFile(config.root);
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
  } else {
    // 配置档早就在了，而 bootstrap 里还留着那几段：它现在是一句谎话。不删用户的文件
    // （框架从不删它），但每次启动都要说一次，否则它会变成第二个真源。
    const leftover = runShapeKeysIn(bootstrap);
    if (leftover.length > 0) {
      logger.warn(
        `atri.config.json 里还留着 ${leftover.join(" / ")}，但配置档已经存在 —— ` +
          `这些段**不再生效**，真源是 ${seedPath}。其中可能仍有明文的 provider apiKey：` +
          `确认无误后把它们从 atri.config.json 里删掉。`,
      );
    }
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

  /**
   * 按当前配置装配这一份档的 provider 注册表。
   *
   * 启动与「配置页改完保存」走的是**同一个函数**，因此不会出现两条装配路径
   * 慢慢走散的情况（例如忘记处理默认值回退）。
   *
   * 单个 provider 配错只记日志、不阻断启动：「其中一个后端坏了」应该能局部降级，
   * 而不是让整个服务起不来。
   */
  function makeRebuildProviders(bundle: MutableBundle) {
    const { providers, providerConfig, profileId } = bundle;
    return function rebuildProviders(): ProviderRegistry {
      providers.clear();

      const entries = providerConfig.providerEntries();
      const { providers: built, errors } = createProviders(entries, {
        sources: providerConfig.sourceEntries(),
        logger,
      });
      for (const provider of built) providers.register(provider);
      for (const { id, message } of errors) {
        logger.error(`配置档「${profileId}」的 provider「${id}」加载失败: ${message}`);
      }

      const defaultId = readDefaultProviderId(entries);
      if (defaultId) {
        // 显式配了默认值但它没加载成功时，别静默回退到第一个——那会让请求
        // 悄悄打到另一个模型上。宁可留空，由注册表的回退规则处理并留下日志。
        if (providers.get(defaultId)) {
          providers.setDefault(defaultId);
        } else {
          logger.warn(
            `配置档「${profileId}」的默认 provider「${defaultId}」未加载成功，将回退到第一个可用 provider`,
          );
        }
      }

      if (providers.size === 0) {
        logger.warn(
          `配置档「${profileId}」没有可用的模型 provider，将使用回声兜底（请在它自己的配置文件里配置 providers）`,
        );
      }
      return providers;
    };
  }

  /** `buildBundle` 里 `reloadProviders` 要引用还在构造中的那份 bundle，所以先给它一个可写的壳。 */
  interface MutableBundle {
    profileId: string;
    providers: ProviderRegistry;
    providerConfig: ProviderConfigStore;
  }

  /**
   * 读一份配置档并**只构造**它的对象图，不登记、不加载插件。
   * 单独成一步是 `POST /profiles/{id}/reload` 的前提：它要先建好**新的**一份，
   * 换掉 Map 里那一条，之后才卸载旧的 —— 在途的那轮对话继续用旧对象图走完。
   * 读文件或校验不过时抛，调用方决定记成 `failed` 还是回给客户端。
   */
  async function buildBundle(id: string): Promise<ProfileBundle> {
    const path = profileConfigPath(profilesDir, id);
    const profile = readProfileConfig(path);
    const providerConfig = new ProviderConfigStore({ filePath: path }, logger);
    const toolConfig = new ToolConfigStore({ filePath: path }, logger);
    const providers = new ProviderRegistry();
    const tools = new ToolRegistry();
    // 传 getter 而不是 `plugins.list()` 的结果：此刻还没 `loadAll()`，而且插件能在运行期
    // 增删与启停，快照会让这颗工具继续说出装配那一刻的事实。
    const shell: MutableBundle = { profileId: id, providers, providerConfig };
    const plugins = new PluginManager(pluginRuntimeConfig(config), logger, {
      // 每个配置档自己的插件数据根。安装是全局的（`config.pluginDirs`），所以同一个插件 id
      // 会在每份档里各出现一次 —— 数据根不分家的话，两份档的同一个插件会互相覆写 token。
      dataRoot: join(profileDir(profilesDir, id), "plugins"),
      disabledIds: disabledPluginsOf(profile),
      // 启用状态写回**这份档**的文件。注入而不是让 `plugins/` 去 import 配置写入器：
      // 分层规则没有检查在守这一条边，而 `list_plugins` 收访问器已经是仓内先例。
      persistEnabled: (pluginId, enabled) => setProfilePluginEnabled(path, pluginId, enabled),
    });
    for (const tool of createBuiltinTools({ listPlugins: () => plugins.list() })) {
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
    });
    const bundle: ProfileBundle = {
      id,
      name: profile.name ?? id,
      path,
      providers,
      providerConfig,
      reloadProviders: makeRebuildProviders(shell),
      tools,
      toolConfig,
      plugins,
      engine,
    };
    // 第一次填充注册表，且**必须在返回之前**：`openProfile()` 与 `profiles.reload()` 都走
    // 这一个构造口，少一句的后果不是报错而是静默降级 —— 注册表空着，每条消息都落到回声
    // 兜底，而 `GET /providers` 照旧显示「已配置」（它读的是配置文件，不是注册表）。
    bundle.reloadProviders();
    return bundle;
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
      states.set(id, { name: id, status: "failed", error: errorMessage(err) });
      logger.error(`配置档「${id}」加载失败: ${errorMessage(err)}`);
      return null;
    }
    bundles.set(id, bundle);
    states.set(id, { name: bundle.name, status: "ready", error: null });
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
    records: () =>
      [...states.entries()]
        .map(([id, state]) => ({
          id,
          name: state.name,
          path: profileConfigPath(profilesDir, id),
          status: state.status,
          error: state.error,
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
        states.set(id, { name, status: "ready", error: null });
      } else {
        const state = states.get(id);
        if (state) states.set(id, { ...state, name });
      }
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
        states.set(id, { name: previous?.name ?? id, status: "failed", error: errorMessage(err) });
        throw new Error(`配置档「${id}」重载失败，仍在使用重载前的对象图：${errorMessage(err)}`, {
          cause: err,
        });
      }
      if (previous) {
        bundles.set(id, next);
        states.set(id, { name: next.name, status: "ready", error: null });
        await previous.plugins.unloadAll();
      } else {
        await closeProfile(id);
        bundles.set(id, next);
        states.set(id, { name: next.name, status: "ready", error: null });
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
    auth,
    sessions,
    lock,
    events,
    profiles,
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
