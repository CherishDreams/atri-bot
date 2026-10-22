import { join } from "node:path";
import type { Logger } from "#core/logger.ts";
import type { PluginInfo } from "@atri/shared";
import { ApiError, errorMessage } from "#core/errors.ts";
import type { PluginSettingsValues } from "./settings.ts";

/**
 * 传给插件上下文的配置：插件可见的运行期配置（`PluginRuntimeConfig` 那份白名单视图）
 * 与插件自己声明的 `config` 段合并后的结果，同名时插件的键优先。
 */
export type PluginContextConfig = Record<string, unknown>;

/** `effect()` 接受的两种副作用形状（其余一律抛错）。 */
export type Disposable = (() => void | Promise<void>) | { dispose: () => void | Promise<void> };

/** EventEmitter 风格的订阅对象。`on`/`off` 可选：有些实现只提供其中一个。 */
export interface Subscribable {
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  off?: (event: string, handler: (...args: unknown[]) => void) => void;
}

/** 插件可见的接入平台摘要：只给调用需要的坐标，不给目录、凭证或错误原文。 */
export interface PluginAdapterSummary {
  id: string;
  name: string;
  type: string;
  running: boolean;
}

/**
 * 插件调用接入平台动作的端口。
 *
 * 与 `plugins()` 同一条注入理由：`plugins/` 不认识适配器层，能力由组合根注入。
 * 实现方必须校验「适配器绑定的配置档 == 当前插件所属配置档」，不能只凭 id 操作
 * 别的档。
 */
export interface PluginAdapterActions {
  list(): PluginAdapterSummary[];
  call(adapterId: string, action: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface PluginContextDeps {
  id: string;
  logger: Logger;
  config: PluginContextConfig;
  /**
   * 操作者为这个插件填的值（`_conf_schema.json` 的默认值 + 它自己的 `config.json`）。
   *
   * **与 `config` 分开，不合并**：`config` 是框架主动交出去的那一份白名单视图，
   * 键集合由 `test/plugin-config.test.ts` 钉着；把用户填的任意键并进去，那条保证就没了。
   * 插件作者读自己的参数用 `ctx.pluginConfig.xxx`。
   */
  pluginConfig: PluginSettingsValues;
  /**
   * 同伴插件的只读视图，由 `PluginManager` 在创建上下文时注入。
   *
   * **收函数而不是数组**：`loadAll()` 按 `pluginDirs` 的顺序逐个 `await`，所以插件 A 的
   * `setup()` 跑起来时插件 B 可能还没加载；`reload()` 与启用/禁用又会在运行期改变这份事实。
   * 传快照等于让每个插件都停留在「自己出生那一刻」看到的插件表上。
   */
  plugins: () => PluginInfo[];
  /**
   * 插件数据的根目录（`<config.dataDir>/plugins`）。**框架私有** —— 插件只能经由
   * `ctx.dataDir` 拿到根目录下**属于它自己那一个**子目录，永远看不到这个根，也看不到
   * `dataDir` 本体（那里面有 `sessions.sqlite`，交出根就等于把全部对话历史递给磁盘上
   * 任一段用户手写的 JS）。
   */
  dataRoot: string;
  /**
   * 建目录并把它收到 `0700`。**由组合根经 `PluginManager` 注入**（见 `PluginStorage`）：
   * 这个函数会 `mkdir` + `chmod`，不是 `ApiError` 那种叶子，而 `plugins/` 的规矩是
   * 「只依赖注入给它的 ctx」—— 同层的 `persistEnabled` 早就按这条办了，这里不该是例外。
   */
  ensurePrivateDir: (dir: string) => void;
  /** 接入平台动作端口；缺省时 `ctx.adapters()` 为空、`ctx.callAction()` 抛错。 */
  adapterActions?: PluginAdapterActions;
}

/**
 * 插件数据目录名的形状。**id 会直接成为路径组件**，所以在这里挡住穿越。
 *
 * 首字符限定字母数字，于是 `..`、`.`、`/`、`\` 都进不来；长度收到 64 是为了不让一个
 * 长得离谱的 id 造出一个难以处理的路径。
 *
 * 刻意不接受大写：`Foo` 与 `foo` 在大小写不敏感的文件系统（macOS、Windows）上落到同一个
 * 目录，而在 Linux 上是两个 —— 那意味着同一份插件数据在不同机器上待在不同地方，且开发者
 * 在自己机器上永远看不见问题。宁可让插件作者改成一个合规的 id。
 */
const DATA_DIR_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * id 能不能直接当目录名用；不能就说清是哪一个约束没满足。
 *
 * 抛 `ApiError(..., 400)` 而不是普通 `Error`：这条校验有两个调用点，而两个点想要的形状不同 ——
 * `PluginManager.load()` 里它决定「这个插件能不能登记」，失败要能以 400 回给控制台而不是 500；
 * `ctx.dataDir` 里它是路径拼接前的最后一道闸，抛出去由插件自己的 `setup()` 收到。
 * 一处规则、两个出口，所以写成共享的函数而不是在两处各写一遍正则与文案。
 */
export function assertPluginDirName(id: string): void {
  if (!DATA_DIR_NAME.test(id)) {
    throw new ApiError(
      `插件 id "${id}" 不能用作数据目录名：只允许小写字母、数字与 . _ -，` +
        `首字符必须是字母或数字，长度 1–64`,
      400,
    );
  }
}

interface Registration {
  release: () => Promise<void>;
  label?: string;
}

/** 对象形状（插件是用户手写的 JS，这里只用来收窄，不做校验）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 插件运行时上下文。每个插件实例独享一个实例。
 *
 * 核心是 `effect()`：插件把副作用（定时器、事件订阅、socket…）交给框架登记，
 * 框架在实例卸载/重载时按注册的**逆序**自动释放。这样资源清理由机制保证，
 * 而不是靠插件作者手写 teardown 记得清干净。
 */
export class PluginContext {
  #disposables: Registration[] = [];
  #disposed = false;
  #peers: () => PluginInfo[];
  #dataRoot: string;
  #ensurePrivateDir: (dir: string) => void;
  #adapterActions?: PluginAdapterActions;
  #dataDir?: string;

  id: string;
  logger: Logger;
  config: PluginContextConfig;
  /** 见 `PluginContextDeps.pluginConfig`。只读：插件读自己的参数，不该改这一份快照。 */
  readonly pluginConfig: PluginSettingsValues;

  constructor({
    id,
    logger,
    config,
    pluginConfig,
    plugins,
    dataRoot,
    ensurePrivateDir,
    adapterActions,
  }: PluginContextDeps) {
    this.id = id;
    this.logger = logger;
    this.config = config;
    this.pluginConfig = pluginConfig;
    this.#peers = plugins;
    this.#dataRoot = dataRoot;
    this.#ensurePrivateDir = ensurePrivateDir;
    this.#adapterActions = adapterActions;
  }

  /** 是否已卸载。卸载后调用 effect 会直接报错，避免泄漏。 */
  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * 这个插件**自己**的数据目录（绝对路径）。首次访问时创建，之后幂等返回同一个值。
   *
   * 与插件本体分开存是刻意的：插件目录是用户从上游拷来的代码，升级时会被整个替换、
   * 重命名时目录名还会变 —— 把数据写在那儿等于写在一条会被覆盖的路上。反过来，数据落在
   * `<dataDir>/plugins/<id>`，键是插件自己声明的 `id` 而不是磁盘目录名，于是用户重命名
   * 插件目录不会丢历史（`test/plugins.test.ts` 有专门一条）。
   *
   * 三条边界与 `plugins()` 同一个规矩，都不在这一版里扩大：
   * - 只给**它自己那一个**目录：不给 `dataRoot`、不给 `dataDir` 本体、不给同伴的目录，
   *   `dataDir` 也仍然**不在** `PluginRuntimeConfig` 那份白名单里。
   * - 框架从不删它：禁用、卸载、重载、关停都不碰这个目录（整个 `apps/server/src` 里
   *   没有任何删除文件的调用）。清理是操作者的事，不是 API 的一个分支。
   * - **惰性创建**：不调用就一次 `mkdir` 都不发生。所以启动不会因为它多碰盘；而建不成
   *   时插件的 `setup()` 收到一句错，`PluginManager.load()` 把这一颗记成 `failed` 并继续
   *   扫下一颗 —— 一颗插件坏了不拖垮别人，这一条由 `#scanDir` 的逐条 try/catch 兑现。
   *
   * id 的合规性在 `load()` 就查过一次（`assertPluginDirName`），这里这道**不是重复劳动**：
   * 它是 `join(#dataRoot, id)` 之前唯一的直接防线，而本类的构造点在框架之外没人管。
   *
   * @throws Error id 不合 `DATA_DIR_NAME`（穿越风险）、或目录创建失败（权限、磁盘）。
   */
  get dataDir(): string {
    // 缓存在实例上没关系：路径由 id 决定，重载换来的新实例算出来的是同一个目录。
    if (this.#dataDir !== undefined) return this.#dataDir;
    assertPluginDirName(this.id);
    const dir = join(this.#dataRoot, this.id);
    // 里面可能有 token、缓存与用户数据：与配置文件（`config/file.ts`）、
    // 会话库（`core/session/db.ts`）共用同一份实现（由组合根注入），而不是各写一遍
    // 「mkdir + chmod」—— 三遍里必有一遍漏掉 `mode`，而漏掉的那条没人会 notice。
    this.#ensurePrivateDir(dir);
    this.#dataDir = dir;
    return dir;
  }

  /**
   * 此刻已登记的插件（**含调用者自己**，也含上一次加载失败的那些），按加载顺序。
   *
   * 返回的是投影过的 `PluginInfo`：只有 `id` / `name` / `version` / `description` / `enabled`。
   * 不给 `dir`（别的插件的磁盘路径）也不给 `error`（那是第三方文本，可能带着绝对路径），
   * 这两条由 `test/plugins.test.ts` 的键集合断言钉住 —— 想多给一个键必须经过一次人的判断，
   * 与 `pluginRuntimeConfig()` 那份配置白名单是同一个规矩。
   *
   * 失败的同伴以 `enabled: false` 出现：这正是你需要的那个事实（别声称它的能力可用），
   * 而「为什么失败」是给操作者的，走 `GET /plugins`。
   */
  plugins(): PluginInfo[] {
    return this.#peers();
  }

  /**
   * 当前配置档绑定的接入平台。只给 id / name / type / running —— 插件要调用动作时
   * 需要的是坐标，不是目录、token 或错误原文。
   *
   * 运行期现读：适配器可能在插件 `setup()` 之后才装配完成（组合根先建配置档、
   * 后建适配器管理器），所以不要在 `setup()` 里把返回值缓存下来。
   */
  adapters(): PluginAdapterSummary[] {
    return this.#adapterActions?.list() ?? [];
  }

  /**
   * 调用接入平台原始动作（AstrBot 的 `call_action`）。
   *
   * 只允许操作绑定到本插件所属配置档的适配器；由注入的实现校验，插件层不重复判断。
   * 动作失败抛错，插件可以 catch 后降级。
   */
  async callAction(
    adapterId: string,
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (this.#adapterActions === undefined) {
      throw new Error("当前插件没有接入平台动作能力");
    }
    return this.#adapterActions.call(adapterId, action, params);
  }

  /**
   * 登记一个副作用。接受：
   *   - 一个函数：卸载时调用它（可返回 Promise）
   *   - 一个带 `.dispose()` 的对象：卸载时调用其 dispose()
   *   - 一个订阅：`{ on(type, fn), off(type, fn) }` + 事件名 + 处理器
   * 返回一个可手动提前释放的函数。
   *
   * 参数是 `unknown` 而不是 `Disposable`：插件是用户手写的 JS，编译器管不到它，
   * 「传错了要抛哪一句」由下面的运行时分派决定，而不是由类型系统提前替它决定。
   */
  effect(target: unknown, label?: string): () => Promise<void> | void {
    if (this.#disposed) {
      throw new Error(`插件 ${this.id} 已卸载，不能再登记 effect`);
    }
    const release = this.#toDisposer(target);
    this.#disposables.push({ release, label });

    let done = false;
    return () => {
      if (done) return;
      done = true;
      const idx = this.#disposables.findIndex((d) => d.release === release);
      if (idx >= 0) this.#disposables.splice(idx, 1);
      return release();
    };
  }

  /** 订阅一个 EventEmitter 风格的对象，卸载时自动退订。 */
  subscribe(
    emitter: Subscribable,
    event: string,
    handler: (...args: unknown[]) => void,
  ): () => Promise<void> | void {
    emitter.on?.(event, handler);
    return this.effect(() => emitter.off?.(event, handler), `subscribe:${event}`);
  }

  #toDisposer(target: unknown): () => Promise<void> {
    if (typeof target === "function") return async () => target();
    // 用局部变量承接一次：`typeof target.dispose === "function"` 的收窄在
    // `Record<string, unknown>` 上不会跨语句保留，换个名字判就能省掉断言。
    const dispose = isRecord(target) ? target.dispose : undefined;
    if (typeof dispose === "function") return async () => dispose();
    throw new Error("effect 需要传入函数或带 dispose() 的对象");
  }

  /** 逆序释放全部副作用。幂等，可安全重复调用。 */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const { release, label } of this.#disposables.toReversed()) {
      try {
        await release();
      } catch (err) {
        this.logger.warn(
          `插件 ${this.id} 释放 effect 失败（${label ?? "匿名"}）: ${errorMessage(err)}`,
        );
      }
    }
    this.#disposables = [];
  }
}
