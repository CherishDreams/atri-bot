import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginInfo, PluginStatus } from "@atri/shared";
import type { Logger } from "#core/logger.ts";
import type { ToolDefinition } from "#core/tool/types.ts";
import { assertCommandDefinition } from "#core/command/registry.ts";
import type { CommandDefinition, CommandEntry } from "#core/command/types.ts";
import type { AppConfig } from "#config/index.ts";
import type { FileConfig } from "#config/file.ts";
import { ApiError, errorMessage } from "#core/errors.ts";
import {
  assertPluginDirName,
  PluginContext,
  type PluginAdapterActions,
  type PluginContextConfig,
} from "./context.ts";
import {
  PLUGIN_CONFIG_FILE,
  PLUGIN_SCHEMA_FILE,
  applyPatch,
  effectiveValues,
  readSchema,
  validatePatch,
  type PluginSettingsSchema,
  type PluginSettingsView,
} from "./settings.ts";

/**
 * 插件契约（`index.js` 默认导出）：
 *   `{ id, name?, version?, description?, config?, setup?(ctx), teardown?() }`
 * 也支持默认导出一个工厂函数 `(shared) => 上述对象`。
 *
 * 这些类型从 `context.ts`/本文件导出，**源码即契约**：仓库不再产出 `.d.ts`
 * （见 `docs/architecture.md` 的插件章节），插件作者要类型就直接读这里。
 */
export interface PluginDefinition {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  /** 与插件可见的运行期配置（`PluginRuntimeConfig`）合并后交给 `ctx.config`，插件的键优先。 */
  config?: PluginContextConfig;
  /**
   * 插件提供的工具。可以是静态数组，也可以拿着 `ctx` 现造（例如系统插件要读
   * `ctx.plugins()`）。工具可以被标成 `internal`，那样只交给模型、不出现在用户的
   * 工具开关里。
   */
  tools?: ToolDefinition[] | ((ctx: PluginContext) => ToolDefinition[]);
  /**
   * 插件提供的指令（`/help` 这类文本协议，见 `core/command/types.ts`）。
   * 与工具同一种形状：静态数组或工厂。名字/别名撞内置指令或其它活跃插件时，
   * **这一颗插件加载失败**（冲突要让加载期就看得见，而不是留一条永不响应的指令）。
   */
  commands?: CommandDefinition[] | ((ctx: PluginContext) => CommandDefinition[]);
  setup?: (ctx: PluginContext) => void | Promise<void>;
  teardown?: () => void | Promise<void>;
}

export type PluginFactory = (shared: PluginShared) => PluginDefinition | Promise<PluginDefinition>;

/** 传给插件工厂的共享能力。 */
export interface PluginShared {
  logger: Logger;
  config: PluginRuntimeConfig;
}

/**
 * 插件可见的运行期配置 —— **白名单**，不是「整份 `AppConfig` 的别名」。
 *
 * 只有一条键，是刻意的：`AppConfig` 里其余的东西（`auth.adminPassword`、
 * 源的 `apiKey`、`providers`、`dataDir`、`staticDir`）没有插件用得到的理由，
 * 却有「磁盘上的任意代码读到口令」这一份风险。要加新键就在下面登记，
 * 并同步 `test/plugin-config.test.ts` 里那条键集合断言 —— 让它必须经过一次人的判断。
 *
 * `dataDir` 被排除的理由**比其它键都硬**：会话与消息库 `sessions.sqlite` 就落在它下面，
 * 把 `dataDir` 交给任何一个插件，等于把用户的**全部对话历史**递到磁盘上手写的 JS 手上。
 * 插件需要存东西时走 `ctx.dataDir` —— 那是 `<dataDir>/plugins/<自己的 id>`，
 * 由框架拼、由框架校验，只包含它自己那一个目录（见 `PluginStorage`）。
 */
export interface PluginRuntimeConfig {
  pluginDirs: string[];
}

/**
 * `PluginManager` 需要的**框架私有**依赖，与 `PluginRuntimeConfig` 严格分开。
 *
 * 分成两个参数而不是往白名单里塞一条，是为了让「什么交给插件、什么不交」这件事在签名上
 * 就看得见：`config` 会一路流到 `ctx.config` 与 `shared.config`，而 `storage` 只用来
 * 在框架内部拼出每个插件自己的目录。
 */
export interface PluginStorage {
  /**
   * 插件数据根目录。多配置档之后它是**这份配置档自己的**
   * `<dataDir>/profiles/<pid>/plugins`，不再是 `<dataDir>/plugins`。
   *
   * 这不是可选的隔离：安装是全局的，所以同一个插件 id 会在每份配置档里各出现一次，
   * 而它们经 `ctx.dataDir` 拿到的是**同一个名字下的不同目录**。共用一个根的话，
   * 两份配置档的同一个插件会互相覆写 token 与缓存。
   */
  dataRoot: string;
  /** 这份配置档显式关掉的插件 id（默认启用，理由见 `PluginManager.#disabled`）。 */
  disabledIds?: string[];
  /**
   * 把启用状态写回配置档文件。**由组合根注入**，`plugins/` 不自己去 import 配置写入器 ——
   * 与 `list_plugins` 收 `() => plugins.list()` 是同一条理由：分层规则没有检查在守，
   * 而注入让这条边界在签名上看得见。
   */
  persistEnabled?: (id: string, enabled: boolean) => void;
  /**
   * 把插件自己的数据目录收到 `0700`（不存在时创建）。**由组合根注入**，必填。
   *
   * 与上面 `persistEnabled` 同一条理由：分层规则没有检查在守 `plugins/ → config/` 这条边，
   * 而 `ensurePrivateDir` 会 `mkdir` + `chmod`，不是 `errorMessage` / `ApiError` 那种叶子。
   * 以前 `plugins/context.ts` 直接 import 它，于是同一层里出现两种形状 ——
   * 写入是注入的、建目录是硬 import 的。必填（而不是可选）的理由与 `filePath: string | null`
   * 那条相同：可选会让「忘了传」和「故意不做」长得一样，而漏掉的后果是
   * 插件的 token 与缓存落在一个 0755 的目录里，且没有任何报错。
   */
  ensurePrivateDir: (dir: string) => void;
  /**
   * 读一份 JSON 配置（不存在 → `{}`；坏 JSON 抛）。**由组合根注入**，
   * 与 `ensurePrivateDir` 同一条理由：`plugins/` 只依赖注入给它的东西，
   * 不 import `config/` 的实现（那条边没有检查在守，注入让边界在签名上看得见）。
   */
  readConfigFileAt: (filePath: string) => FileConfig;
  /** 原子写一份 JSON（同目录 `.tmp` → 0600 → rename），同样由组合根注入。 */
  writeConfigFileAt: (filePath: string, config: FileConfig) => string;
  /**
   * 接入平台动作端口。由组合根注入并**按配置档过滤**——插件只能操作绑定到
   * 自己这份档的适配器。缺省时插件仍能加载，只是 `ctx.adapters()` 为空。
   */
  adapterActions?: PluginAdapterActions;
  /**
   * 内置指令已经占用的名字与别名（归一化小写）。由组合根从这一档的
   * `CommandRegistry.takenNames()` 注入，让「插件指令撞内置指令」在加载期
   * 就被拒绝成 failed —— 与工具撞号的跨插件检查同一条严格度。
   */
  commandsTaken?: () => Set<string>;
}

/**
 * 把完整配置投影成插件可见的那一份。只有插件需要这一步：`api/` / `core/` / `adapters/`
 * 是仓内代码，读配置的是我们自己写的逻辑；插件是磁盘上用户手写的 JS，而 `ctx.config`
 * 是框架**主动交出去**的那一份。它仍在同一进程内，所以这不是沙箱，原理见 architecture.md。
 */
export function pluginRuntimeConfig(config: AppConfig): PluginRuntimeConfig {
  // 数组要拷一份：白名单里的键是可写的引用值，共享同一个数组的话，
  // 插件一次 `push` 就能改到运行期配置本体（进而改变下一次扫描的目录）。
  return { pluginDirs: [...config.pluginDirs] };
}

/**
 * 运行时记录：模块之外由框架持有的那一份状态。
 *
 * `dir` 是 `#records` 的键，也是**解析后的绝对路径**。用目录而不是插件自报的 id 做键，
 * 理由有两条，都被「两个目录声明同一个 id」这一对触发：
 * - 加载可以在拿到 id **之前**就失败（`index.js` 语法错、导出的对象没有 id），那时 id 不存在；
 * - 以 id 为键时，B 目录一次坏加载会把 A 目录那份**健康**的记录连实例一起顶掉
 *   （旧版 `load()` 的同 id 预 teardown 就是这个行为），一次失败足够干掉别人。
 *
 * 对外的 id 是 `meta.id`，由 `#find()` 反查；键与对外标识分开，才有「失败记录用一个派生
 * id 对外可见」这种形状（见 `PluginMeta.id`）。
 */
interface PluginRecord {
  /** 解析后的插件目录绝对路径，同时是 `#records` 的键。 */
  dir: string;
  /** 插件自报的 id；在拿到它之前就失败时为 `null`。对外的键是 `meta.id`。 */
  id: string | null;
  /**
   * 这条记录是否**占用**它的 id。
   *
   * 冲突被拒的那一条也带着自报 id（让操作者看得见「是谁想用这个名字」），但它没有拿到
   * `<dataRoot>/<id>` 的钥匙：占用者仍是先登记的那一条。`#find()` 与冲突判据都只看占用者；
   * 否则一个 failed 的落选者会永久挡住赢家的 reload。
   */
  ownsId: boolean;
  /**
   * 实例化成功后的定义。**失败记录一定是 `null`** —— 于是 `#teardown()` 绝不会把一个
   * 从没构造完的实例的 `teardown()` 调出去：插件作者有理由假设它至多跑一次、且只在成功
   * `setup()` 之后跑。
   */
  plugin: PluginDefinition | null;
  /** 运行期上下文。失败记录一定是 `null`：要么没建，要么建了但在写记录之前已经 dispose。 */
  ctx: PluginContext | null;
  /** 这颗插件提供的工具；只有 active 记录非空。 */
  tools: ToolDefinition[];
  /** 这颗插件提供的指令；只有 active 记录非空。 */
  commands: CommandDefinition[];
  status: PluginStatus;
  /** 上一次加载失败的可读原因；正常为 `null`。只给操作者，见 `#peers()` 与 `list_plugins`。 */
  error: string | null;
  /** 插件目录里 `_conf_schema.json` 的读取结果（import 之前就读，失败记录也带着）。 */
  settings: PluginSettingsSchema;
  meta: PluginMeta;
}

/** `shared.PluginInfo` 里没有 `error`，而列表接口要带它，所以这里是扩展而不是平行。 */
export type PluginView = PluginInfo & { error: string | null };

interface PluginMeta {
  /**
   * 对外的 id：插件自报的那个，或者**失败发生在拿到 id 之前**时的目录名（`basename(dir)`）。
   *
   * 保持必填而不是 `string | null`：`PluginInfo.id` 是必填（`shared/types.ts`），而 `#view()`
   * 直接展开 `meta`，线协议上没有「没有 id」这个表达。取目录名而不是绝对路径，是因为
   * `meta.dir` 本来就是目录名 —— 控制台显示什么就能被回填什么，不给「外传绝对路径」添一把新梯子。
   */
  id: string;
  name: string;
  version: string;
  description?: string;
  dir: string;
}

/**
 * 解析插件声明的工具，并在登记前挡住坏形状与同插件内重复。
 *
 * 工具 id 会进 provider 的 `function.name`、日志与插件页；只接受小写字母/数字开头的
 * 安全字符，避免用换行伪造日志行。跨插件的同 id 冲突在 `load()` 里按 active 记录检查。
 */
function resolvePluginTools(
  pluginId: string,
  plugin: PluginDefinition,
  ctx: PluginContext,
): ToolDefinition[] {
  const declared = typeof plugin.tools === "function" ? plugin.tools(ctx) : (plugin.tools ?? []);
  const seen = new Set<string>();
  for (const tool of declared) {
    if (typeof tool?.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tool.id)) {
      throw new ApiError(
        `插件「${pluginId}」的工具 id「${String(tool?.id)}」不合法：` +
          "只允许小写字母、数字与 . _ -，首字符必须是字母或数字，长度 1–64",
        400,
      );
    }
    if (typeof tool.run !== "function") {
      throw new ApiError(`插件「${pluginId}」的工具「${tool.id}」缺少 run()`, 400);
    }
    if (typeof tool.description !== "string" || tool.description.trim() === "") {
      throw new ApiError(`插件「${pluginId}」的工具「${tool.id}」缺少 description`, 400);
    }
    if (
      tool.parameters === null ||
      typeof tool.parameters !== "object" ||
      Array.isArray(tool.parameters)
    ) {
      throw new ApiError(`插件「${pluginId}」的工具「${tool.id}」缺少 parameters 对象`, 400);
    }
    if (tool.name !== undefined && typeof tool.name !== "string") {
      throw new ApiError(`插件「${pluginId}」的工具「${tool.id}」的 name 必须是字符串`, 400);
    }
    if (seen.has(tool.id)) {
      throw new ApiError(`插件「${pluginId}」重复声明了工具「${tool.id}」`, 400);
    }
    seen.add(tool.id);
  }
  return [...declared];
}

/**
 * 解析插件声明的指令，并在登记前挡住坏形状与同插件内重复。
 *
 * 与 `resolvePluginTools` 同一条设计：校验在 `setup()` 之前做，坏指令让**这一颗插件**
 * 加载失败，而不是留一条永不响应的指令。跨来源冲突（内置指令、其它活跃插件）由
 * `load()` 在这里的结果之上检查。
 */
function resolvePluginCommands(
  pluginId: string,
  plugin: PluginDefinition,
  ctx: PluginContext,
): CommandDefinition[] {
  const declared =
    typeof plugin.commands === "function" ? plugin.commands(ctx) : (plugin.commands ?? []);
  const seen = new Set<string>();
  for (const def of declared) {
    assertCommandDefinition(def, `插件「${pluginId}」的`);
    const names = [def.name, ...(def.aliases ?? [])].map((n) => n.trim().toLowerCase());
    for (const name of names) {
      if (seen.has(name)) {
        throw new ApiError(`插件「${pluginId}」重复声明了指令名「${name}」`, 400);
      }
      seen.add(name);
    }
  }
  return [...declared];
}

/**
 * 插件管理器：负责插件的发现、加载、重载、启用/禁用与卸载。
 *
 * 关键设计 —— 把「模块加载」和「实例创建」分开：
 *   - 模块：Node 的 ESM 一旦 import 就进入模块图，没有标准 API 可以移除它。
 *     因此这里不试图卸载模块，而是在重载时用 cache-busting（带 `?v=` 查询参数）
 *     重新 import，拿到重新求值过的代码。
 *   - 实例：每次加载都由框架创建一个插件实例，并把它的副作用登记到
 *     `PluginContext`。卸载 = 逆序释放 effect + 调 teardown + 丢弃实例。
 *     所以即便模块仍在模块图里，实例也能干净地销毁与重建。
 */
export class PluginManager {
  #records = new Map<string, PluginRecord>();
  /** 带自增序号的缓存击穿计数器，保证每次重载都能拿到新代码 */
  #revision = 0;
  /**
   * 本实例的缓存击穿命名空间。存在的唯一理由是 `#importFresh` 那段注释：
   * 现在同一份磁盘上会有多个管理器扫同一批目录，光靠 `?v=` 会让它们互相命中模块缓存。
   */
  #nonce = randomUUID();

  config: PluginRuntimeConfig;
  logger: Logger;
  /** 框架私有的数据根与启用名单（`<dataDir>/profiles/<pid>/plugins` + 显式禁用的 id）。 */
  #storage: PluginStorage;
  /**
   * 这份配置档**显式关掉**的插件 id。
   *
   * 存禁用名单而不是允许名单：判据是「默认启用，除非 profile 里写了 `enabled: false`」
   *（与适配器同侧，而与工具相反）。允许名单会把「profile 还没写过这条插件」读成「不启用」，
   * 那正好是要装完就能用的新手的第一次体验。
   */
  #disabled = new Set<string>();

  constructor(config: PluginRuntimeConfig, logger: Logger, storage: PluginStorage) {
    this.config = config;
    this.logger = logger;
    // `dataRoot` 只用来在框架内部拼每个插件自己的目录，永远不进 `ctx.config` 也不进
    // `shared.config`（见 `PluginStorage` 与 `ctx.dataDir`），所以它是私有字段。
    this.#storage = storage;
    for (const id of storage.disabledIds ?? []) this.#disabled.add(id);
  }

  /**
   * 插件可见的那份运行期配置，**每次现拷**。
   *
   * 为什么不复用 `this.config`：`pluginDirs` 是数组引用值。浅层展开出来的那份
   * `{ pluginDirs: [...] }` 里躺着的是同一个数组，插件一次 `push` 就能改到管理器自己在
   * `loadAll()` 循环里读的那一份 —— 而 `loadAll()` 的循环**正是**在被这个数组驱动。
   * `pluginRuntimeConfig()` 在装配处拷了一次（挡住「整份 `AppConfig` 递出去」），
   * 这一处挡的是「拷过的形状又被共享回去」。同一个理由，两个出口，见 AGENTS.md
   * 「窄的类型标注不等于窄的现实」。
   */
  #configForPlugin(): PluginRuntimeConfig {
    return { pluginDirs: [...this.config.pluginDirs] };
  }

  /** 供插件使用的共享能力。 */
  get shared(): PluginShared {
    return { logger: this.logger, config: this.#configForPlugin() };
  }

  async loadAll(): Promise<void> {
    for (const dir of this.config.pluginDirs) {
      await this.#scanDir(dir);
    }
    const records = [...this.#records.values()];
    const active = records.filter((r) => r.status === "active").length;
    const failed = records.filter((r) => r.status === "failed").length;
    // 两个数进同一句而不是分两行：「加载了几个 / 坏了几个」是一件事的两半，
    // 分行会被只 grep 一行的部署脚本漏掉。零失败时保持既有那行的形状不变。
    this.logger.info(
      failed === 0
        ? `已加载 ${active} 个插件`
        : `已加载 ${active} 个插件，${failed} 个加载失败（原因见控制台插件页与上面的 warn）`,
    );
  }

  async #scanDir(dir: string): Promise<void> {
    let entries;
    try {
      // 排序不是审美：同 id 冲突时「先到先得」的赢家必须跨机器、跨文件系统一致，
      // 而 readdir 的顺序只保证是目录序，不保证稳定。
      entries = (await readdir(dir)).toSorted();
    } catch {
      return; // 插件目录不存在是可以接受的
    }

    for (const name of entries) {
      const pluginDir = join(dir, name);
      const info = await stat(pluginDir).catch(() => null);
      if (!info?.isDirectory()) continue;
      // 这两个 "index.js" 是**磁盘上的入口文件名**，不是 import 说明符：
      // 插件由用户手写、按约定提供 index.js，本仓迁到 TS 不改变这个契约。
      const entry = join(pluginDir, "index.js");
      const ok = await stat(entry).catch(() => null);
      if (!ok) continue;
      // **逐条** try/catch，而不是包整圈循环、也不是包在 `loadAll()` 外面：
      // 后两者都会把「一个插件坏了」变成「它后面那些根本没被看过」。
      // `load()` 在抛之前已经把这一颗记成 `failed`，所以操作者仍然看得见它，只是不拖垮启动。
      try {
        await this.load(pluginDir);
      } catch (err) {
        this.logger.warn(`插件加载失败（${name}）: ${errorMessage(err)}`);
      }
    }
  }

  /**
   * 加载（或重新加载）某个插件目录，返回其对外元数据。
   *
   * 失败时**先写一条 `failed` 记录，再原样重抛**。这里只抛一次，但有两个方向不同的消费者：
   * `#scanDir()` 逐条吞掉（坏一颗不影响别人启动），而 `reload()` 与
   * `POST /plugins/:id/reload` 的调用方要拿到异常与原因。给 `load()` 加「安静模式」参数
   * 会让这两条路径慢慢走散，所以选了「一处更新状态、异常交给调用方决定」的形状。
   */
  async load(pluginDir: string): Promise<PluginView> {
    const dir = resolve(pluginDir);
    // schema 与 import 无关：插件代码坏了也照样能读出它声明了哪些配置项，
    // 于是控制台至少能说清「这个插件本来该有哪些参数」。
    const settings = readSchema(dir);
    // 只在我们真的拿到过一个定义之后才填它：失败记录要靠它维持对外的 id 与名字，
    // 而「导出没有 id」那种失败本来就没有 id 可维持，退回目录名才是对的。
    let declared: PluginDefinition | null = null;
    // 一旦 id 通过校验就默认占用；只有「撞上另一个占用者」的失败要把它退回 false。
    let ownsId = false;
    try {
      const module = await this.#importFresh(join(dir, "index.js"));
      // 插件是用户手写的 JS，模块形状只能在运行时收窄：默认导出优先，
      // 工厂写法先调用它拿到定义，然后统一由下面的 `!plugin?.id` 守卫把关。
      const exported: unknown = module.default ?? module;
      const plugin = (
        typeof exported === "function" ? await exported(this.shared) : exported
      ) as PluginDefinition;
      // 消息用目录名而不是 `resolve()` 之后的绝对路径：操作者按目录名辨认插件
      // （`meta.dir` 就是它，控制台已经在显示），绝对路径在容器里只是一串没人抄的字符。
      if (typeof plugin?.id !== "string" || plugin.id.length === 0) {
        throw new ApiError(
          `插件缺少 id：目录「${basename(dir)}」下的 index.js 没有导出字符串 id`,
          400,
        );
      }
      const id = plugin.id;
      // id 会进日志、进 `list_plugins` 的模型可见文本、进 `ctx.dataDir` 的路径组件，
      // 所以在登记之前就挡一次：含 `\n` 的 id 能伪造日志行，含 `/` 或 `..` 的能穿出数据根目录。
      // `ctx.dataDir` 里那道校验保留 —— 它是路径拼接的直接防线，不是这里的重复劳动。
      assertPluginDirName(id);
      // 从这一行起，失败记录可以沿用插件自报的 id 与名字（被冲突拒掉的那一条也要让操作者
      // 看得见「是谁、声明了哪个 id」）。上面那道校验已经保证这个 id 拿得出手。
      declared = plugin;
      ownsId = true;

      // **另一个目录**声明了同一个 id 就拒绝。id 是 `ctx.dataDir` 的唯一坐标（目录键只用来
      // 定位槽位），所以两条同 id 的记录会拿到同一个数据目录 —— 后加载的那个因此经框架之手
      // 读到前一个插件存的 token 与用户数据。这不是沙箱能补救的事，只能不让它发生。
      // 判据含失败与被禁用的记录（不只是 active）：先到先得是确定的规则，
      // 「谁活着谁优先」会让同一对插件在重启后互换。failed 也必须算冲突：它的 setup()
      // 可能已经碰过 <dataRoot>/<id>，把它让给另一个目录就是主动交出那份数据。
      // 但**被冲突拒掉的失败记录不是占用者**（ownsId=false），否则它会反过来挡住
      // 赢家的 reload。`r.dir !== dir` 那一条让同一目录的重载不受影响。
      const clash = [...this.#records.values()].find(
        (r) => r.ownsId && r.id === id && r.dir !== dir,
      );
      if (clash) {
        ownsId = false;
        throw new ApiError(
          `插件 id "${id}" 与已加载的插件冲突（目录「${basename(clash.dir)}」已经声明了它）`,
          400,
        );
      }

      // 同一个目录的那一条（重载 / 重新启用）先销毁旧实例；别的目录一律不动。
      const existing = this.#records.get(dir);
      if (existing) await this.#teardown(existing);

      // 这份配置档把它关掉了：**不建 ctx、不跑 `setup()`**，只登记一条 `disabled` 记录，
      // 让控制台仍然看得见「装是装了，这份配置档没开它」。
      //
      // 为什么判据在 import 之后：要用插件**自报的 id**，而 id 只能从模块里拿。
      // 为什么必须在这里判而不是「先跑 setup 再禁用」：`setup()` 是长驻副作用的起点
      //（起监听、登录、开定时器），跑过之后再关就得走完整的 teardown 路径，
      // 而「这份配置档没开这个插件」的第一次启动根本不该有副作用发生。
      if (this.#disabled.has(id)) {
        const off = this.#disabledRecord(dir, plugin, settings);
        this.#records.set(dir, off);
        return this.#view(off);
      }

      /*
       * 读用户配置。放在**禁用判断之后**：一份关掉的插件不该因为配置文件坏了而变成
       * failed —— 它本来就没在跑，坏文件只影响「打开配置抽屉时显示什么」。
       * 读在销毁旧实例之前（上面那步已经拆完了，这里只是顺序上的就近）：文件坏掉时
       * 抛错，这一颗记为 failed，操作者可以在插件页里用表单重建（`saveConfig` 对坏文件
       * 以 `{}` 为基底重写）。
       */
      let saved: FileConfig = {};
      try {
        saved = this.#storage.readConfigFileAt(this.#configPath(id));
      } catch (err) {
        throw new ApiError(`插件「${id}」的配置文件读不出来：${errorMessage(err)}`, 400, {
          cause: err,
        });
      }
      const effective = effectiveValues(settings.fields, saved);

      const ctx = new PluginContext({
        id,
        logger: this.logger,
        config: { ...this.#configForPlugin(), ...plugin.config },
        // 用户值为 **schema 默认值 + config.json 里的合法值**；与上面 `config` 分开，
        // 理由见 `PluginContextDeps.pluginConfig`。
        pluginConfig: effective.values,
        // 传的是闭包而不是 `this.#peers()` 的结果：`load()` 是在 `loadAll()` 的循环里逐个
        // await 的，此刻后面的插件还没进 `#records`，快照会让先加载的那个永远看不见后加载的。
        plugins: () => this.#peers(),
        // 只给根，插件经 `ctx.dataDir` 看到的是根目录下**它自己那一个**子目录；
        // `dataDir` 本体（里面有 `sessions.sqlite`）始终不外传，理由见 `PluginRuntimeConfig`。
        dataRoot: this.#storage.dataRoot,
        ensurePrivateDir: this.#storage.ensurePrivateDir,
        ...(this.#storage.adapterActions === undefined
          ? {}
          : { adapterActions: this.#storage.adapterActions }),
      });

      // 工具在 setup 之前解析：工具工厂只该读 ctx 的静态能力（例如同伴列表），
      // 不应依赖 setup 里的长驻副作用。这样工具形状/ id 冲突能在跑 `setup()` 之前被拒，
      // 不会出现「插件已经起了监听，才因为工具 id 撞号被卸载」的半截状态。
      let tools: ToolDefinition[];
      try {
        tools = resolvePluginTools(id, plugin, ctx);
      } catch (err) {
        await ctx.dispose();
        throw err;
      }
      for (const other of this.#records.values()) {
        if (other.status !== "active" || other.dir === dir) continue;
        const toolClash = tools.find((tool) => other.tools.some((owned) => owned.id === tool.id));
        if (toolClash) {
          await ctx.dispose();
          throw new ApiError(
            `插件「${id}」的工具「${toolClash.id}」与插件「${other.meta.id}」冲突`,
            400,
          );
        }
      }

      // 指令在工具之后解析，同一套「setup 之前拒绝」的次序：跨来源冲突在这里查
      //（内置指令的名字由组合根经 `commandsTaken` 注入，其它活跃插件的名字现读）。
      let commands: CommandDefinition[];
      try {
        commands = resolvePluginCommands(id, plugin, ctx);
      } catch (err) {
        await ctx.dispose();
        throw err;
      }
      const taken = new Set(this.#storage.commandsTaken?.() ?? []);
      for (const other of this.#records.values()) {
        if (other.status !== "active" || other.dir === dir) continue;
        for (const def of other.commands) {
          for (const name of [def.name, ...(def.aliases ?? [])])
            taken.add(name.trim().toLowerCase());
        }
      }
      for (const def of commands) {
        for (const name of [def.name, ...(def.aliases ?? [])]) {
          const key = name.trim().toLowerCase();
          if (!taken.has(key)) continue;
          await ctx.dispose();
          throw new ApiError(
            `插件「${id}」的指令「${def.name}」与已有指令重名（${key}），不能重复注册`,
            400,
          );
        }
      }

      try {
        await plugin.setup?.(ctx);
      } catch (err) {
        await ctx.dispose();
        throw new ApiError(`插件 ${id} 初始化失败: ${errorMessage(err)}`, 400, { cause: err });
      }

      const record: PluginRecord = {
        dir,
        id,
        ownsId: true,
        plugin,
        ctx,
        tools,
        commands,
        status: "active",
        error: null,
        settings,
        meta: {
          id,
          name: plugin.name ?? id,
          version: plugin.version ?? "0.0.0",
          description: plugin.description,
          dir: basename(dir),
        },
      };
      this.#records.set(dir, record);
      this.logger.info(`插件已加载: ${id}`);
      // 直接视图化刚建好的那份记录：`#records.get()` 在类型上可能为空，
      // 而这里注定存在，握着引用比再查一次更清楚。
      return this.#view(record);
    } catch (err) {
      this.#records.set(
        dir,
        this.#failedRecord(dir, errorMessage(err), declared, settings, ownsId),
      );
      throw err;
    }
  }

  /**
   * 造一条失败记录。`declared` 是已经拿到的插件定义（拿到 id 之前就失败时为 `null`）：
   * 有它就把对外的 id 维持成插件自己声明的那个，`reload()` 才按控制台显示的那个 id 找得回来。
   */
  #failedRecord(
    dir: string,
    reason: string,
    declared: PluginDefinition | null,
    settings: PluginSettingsSchema,
    ownsId: boolean,
  ): PluginRecord {
    const name = basename(dir);
    const id = declared?.id || name;
    return {
      dir,
      id: declared?.id ?? null,
      ownsId,
      plugin: null,
      ctx: null,
      tools: [],
      commands: [],
      status: "failed",
      error: reason,
      settings,
      meta: {
        id,
        name: declared?.name ?? id,
        version: declared?.version ?? "0.0.0",
        ...(declared?.description === undefined ? {} : { description: declared.description }),
        dir: name,
      },
    };
  }

  /**
   * 造一条「这份配置档没开它」的记录。
   *
   * `plugin: null` 是有意的，而且是 `#teardown()` 那条不变量的另一半：这个实例从没跑过
   * `setup()`，所以没有任何东西可释放。留着定义对象的话，操作者随后点「卸载」就会把
   * `teardown()` 调给一个从没启动过的插件。
   */
  #disabledRecord(
    dir: string,
    plugin: PluginDefinition,
    settings: PluginSettingsSchema,
  ): PluginRecord {
    return {
      dir,
      id: plugin.id,
      ownsId: true,
      plugin: null,
      ctx: null,
      tools: [],
      commands: [],
      status: "disabled",
      error: null,
      settings,
      meta: {
        id: plugin.id,
        name: plugin.name ?? plugin.id,
        version: plugin.version ?? "0.0.0",
        ...(plugin.description === undefined ? {} : { description: plugin.description }),
        dir: basename(dir),
      },
    };
  }

  /** 重载单个插件：销毁旧实例 -> 重新 import 模块 -> 创建新实例。 */
  async reload(id: string): Promise<PluginView> {
    const rec = this.#find(id);
    if (!rec) throw new ApiError(`未知插件: ${id}`, 404);
    this.logger.info(`正在重载插件: ${id}`);
    return this.#retryLoad(rec);
  }

  /**
   * 「重试某条槽位」的唯一实现：`reload()` 与 `setEnabled(id, true)` 都走这里。
   *
   * 它**不** catch：`load()` 已经在抛出之前把 `failed` 写进同一个槽位了，所以操作者照旧拿到
   * 异常与原因，而记录不再谎报 active。旧写法是 `await this.#teardown(rec); return this.load(...)`
   * 摊在两处，新代码抛错时旧记录仍以 active 留在表里、而它的 ctx 早就 dispose 了 ——
   * `list()` 与 `list_plugins` 于是双双说谎。
   */
  async #retryLoad(rec: PluginRecord): Promise<PluginView> {
    await this.#teardown(rec);
    return this.load(rec.dir);
  }

  /** 卸载单个插件：释放副作用并销毁实例，从管理器中移除。**不删数据目录**（见 `ctx.dataDir`）。 */
  async unload(id: string): Promise<{ id: string; unloaded: boolean }> {
    const rec = this.#find(id);
    if (!rec) throw new ApiError(`未知插件: ${id}`, 404);
    await this.#teardown(rec);
    // 删的是 `rec.dir` 而不是传进来的 `id`：`#records` 的键已经换成目录（见 `PluginRecord`）。
    this.#records.delete(rec.dir);
    this.logger.info(`插件已卸载: ${id}`);
    return { id, unloaded: true };
  }

  /**
   * 启用/禁用**这份配置档**的插件。
   * 禁用 = 释放副作用、标记为 disabled（保留元数据以便再启用）；
   * 启用 = 从原目录重新加载。
   *
   * 顺序上刻意**先落盘、后动内存**：`persistEnabled` 抛错时（配置档文件坏了、磁盘满了）
   * 整个操作什么都没发生，调用方拿到 500 而界面下次拉到的还是原状。反过来做会留下
   * 「内存里开了、文件里没写」的状态，而重启之后它会静默变回去 —— 那比一次失败更难查。
   */
  async setEnabled(id: string, enabled: boolean): Promise<PluginView> {
    const rec = this.#find(id);
    if (!rec) throw new ApiError(`未知插件: ${id}`, 404);
    this.#storage.persistEnabled?.(id, enabled);

    if (enabled) {
      this.#disabled.delete(id);
      if (rec.status === "active") return this.#view(rec);
      return this.#retryLoad(rec);
    }

    this.#disabled.add(id);
    // 已经是 disabled 就原样返回；**failed 也原样返回**：它没有运行期资源可释放，
    // 把它标成 disabled 只是把诊断信息藏起来，而控制台上那条记录的按钮本来就该是「重载」。
    // （`#disabled` 里已经记下这份配置档不要它，所以它的 error 只在**这一次**运行里可见，
    // 下一次启动它会以 disabled 出现 —— 不必为了「立刻看起来像禁用」而牺牲诊断。）
    if (rec.status !== "active") return this.#view(rec);
    await this.#teardown(rec);
    rec.status = "disabled";
    this.logger.info(`插件已禁用: ${id}`);
    return this.#view(rec);
  }

  /**
   * 释放一个记录的运行时资源（teardown + 逆序 effect），保留记录本身。
   *
   * **调完就把 `rec.plugin` 清空**，这是一条结构保证而不是清理：`PluginRecord.plugin`
   * 的注释写着「插件作者有理由假设 `teardown()` 至多跑一次、且只在成功 `setup()` 之后跑」，
   * 而 `#retryLoad()` 会先 `#teardown(rec)` 再 `load(rec.dir)`，`load()` 里那道
   * `existing` 检查又 `#teardown` 一次 —— 同一次重载以前会把 `teardown()` 调两遍。
   * 清空之后第二次进来就是个空操作。`rec.plugin` 全仓**只**被这里读，所以清掉不丢信息。
   */
  async #teardown(rec: PluginRecord): Promise<void> {
    // `plugin === null` 是「从没构造成功，或者已经释放过」的类型级事实：
    // 没有实例就没有 teardown 可调。少了这道守卫，`unload()` 一条失败记录会当场 TypeError。
    if (rec.plugin) {
      const plugin = rec.plugin;
      rec.plugin = null;
      try {
        await plugin.teardown?.();
      } catch (err) {
        this.logger.warn(`插件 ${rec.meta.id} teardown 失败: ${errorMessage(err)}`);
      }
    }
    await rec.ctx?.dispose();
    rec.ctx = null;
  }

  /** 用带版本参数的 URL 重新 import，绕过 ESM 模块缓存。 */
  async #importFresh(entryPath: string): Promise<Record<string, unknown>> {
    // **`atri` 那一段是跨实例唯一的，不是装饰**。`#revision` 每个实例各自从 0 开始数，
    // 而现在同一个磁盘上有 N 个管理器（每份配置档一个），并且它们扫的是**同一批**
    // `pluginDirs` —— 于是两个管理器会对同一个 `index.js` 算出**完全相同**的 `?v=1`。
    // Node 的 ESM 缓存按 URL 键，命中就意味着 B 拿到的是「A 求值过的那个模块对象」：
    // 插件模块级的那些可变状态（连接池、缓存、`let bot`）由 A 与 B 共享，而最后一次
    // `setup(ctx)` 赢者通吃 —— B 的插件会往 **A** 的数据目录里写。
    // 加了 nonce，每个管理器的 URL 都不同，每个配置档拿到自己那份求值结果。
    // 代价要写在 README 的插件契约里：同一个 `index.js` 被求值 N 次，
    // 所以模块顶层的一次性副作用会执行 N 次，该进 `setup()` 的状态要进 `setup()`。
    const url = `${pathToFileURL(entryPath).href}?atri=${this.#nonce}&v=${++this.#revision}`;
    // 动态 import 的返回类型在这里就是未定的：插件是用户手写的 JS。
    // 真正的收窄发生在下面（`module.default ?? module` + `!plugin?.id` 守卫）。
    return import(url);
  }

  /**
   * 按**对外的 id** 找记录。`meta.id` 就是 `#view()` 交出去的那个 id，所以「控制台与插件看到的
   * id」和「这里查得到的 id」永远一致，失败记录那个派生出来的 id 也不例外。
   *
   * 线性扫描而不是第二份 id→记录的 Map：插件数是个位数，多一份索引就多一处必须同步的真相，
   * 而这一层没有按 id 高频读的路径（`list()` 才是主用途）。
   *
   * 两条记录可以共有同一个 `meta.id`：被冲突拒绝的那一条也带着它自报的 id（这样操作者才看得懂
   * 失败原因）。那种情况下这里优先返回 `ownsId` 的那一条 —— 按 id 的 reload/unload/enable
   * 因此都落在赢家身上；赢家被卸载后才退回落选者，方便操作者把它清理掉。
   */
  #find(id: string): PluginRecord | null {
    // 先找真正占用这个 id 的记录；冲突落选者只作为兜底（例如赢家已经被卸载，
    // 而操作者还要按控制台显示的那个 id 把它清理掉）。
    let fallback: PluginRecord | null = null;
    for (const rec of this.#records.values()) {
      if (rec.meta.id !== id) continue;
      if (rec.ownsId) return rec;
      fallback ??= rec;
    }
    return fallback;
  }

  get(id: string): PluginView | null {
    const rec = this.#find(id);
    return rec ? this.#view(rec) : null;
  }

  list(): PluginView[] {
    return [...this.#records.values()].map((r) => this.#view(r));
  }

  /**
   * 当前 active 插件提供的工具。`ToolRegistry` 把这个方法登记成动态来源，
   * 每次 `list()` 现读，所以重载/禁用后下一轮请求立刻看不到旧工具。
   */
  tools(): ToolDefinition[] {
    return [...this.#records.values()]
      .filter((record) => record.status === "active")
      .flatMap((record) => record.tools);
  }

  /**
   * 当前 active 插件提供的指令，带来源 id。`CommandRegistry` 把这个方法登记成
   * 动态来源（与 `tools()` 同一条现读语义：重载/禁用后下一条消息就看不到旧指令）。
   */
  commands(): CommandEntry[] {
    return [...this.#records.values()]
      .filter((record) => record.status === "active")
      .flatMap((record) => record.commands.map((def) => ({ def, source: record.meta.id })));
  }

  /**
   * 同伴视图的公开出口（`/plugins` 内置指令用）。与 `ctx.plugins()` 是同一份投影：
   * 只给 id/name/version/description/enabled，不给 dir 与 error —— 指令的回复会
   * 发进聊天窗口，操作者才看的诊断字段不该从这条路出去。
   */
  peers(): PluginInfo[] {
    return this.#peers();
  }

  #view(rec: PluginRecord): PluginView {
    return {
      ...rec.meta,
      status: rec.status,
      enabled: rec.status === "active",
      error: rec.error,
      // 同 id 冲突里的输家也声明了 id，但按 id 查会落到赢家身上 —— 给它一个「配置」
      // 按钮只会改到别人。所以只有「按 id 真的找得到这一条」的记录才算可配置。
      configurable:
        rec.id !== null && rec.settings.present && this.#find(rec.meta.id)?.dir === rec.dir,
    };
  }

  /** 一份插件配置的当前视图：schema + 生效值 + 两类错误。 */
  getConfig(id: string): PluginSettingsView {
    const rec = this.#find(id);
    if (!rec) throw new ApiError(`未知插件: ${id}`, 404);
    const pluginId = this.#configurableId(rec);

    // schema 坏了：仍然给一个可打开的抽屉（带 schemaError），但不给半张表单。
    if (rec.settings.error !== null) {
      return {
        id: pluginId,
        configurable: true,
        fields: [],
        schemaError: rec.settings.error,
        configError: null,
      };
    }

    let saved: FileConfig = {};
    let configError: string | null = null;
    try {
      saved = this.#storage.readConfigFileAt(this.#configPath(pluginId));
    } catch (err) {
      // 坏文件不抛给 GET：抽屉要能打开，操作者才看得见错误并重建它。
      configError = `配置文件读不出来：${errorMessage(err)}`;
    }
    const effective = effectiveValues(rec.settings.fields, saved);
    return {
      id: pluginId,
      configurable: true,
      fields: rec.settings.fields.map((field) => ({
        ...field,
        value: effective.values[field.key] ?? field.default,
      })),
      schemaError: null,
      configError: configError ?? effective.configError,
    };
  }

  /**
   * 保存一批配置值：**先全部校验、再写、最后重载**。
   *
   * 重载是必须的：插件在 `setup()` 里读 `ctx.pluginConfig`，只改文件不会让它手里的值变；
   * 而重载失败不能回收文件 —— 操作者刚填的东西是有效的，失败的是插件自己的初始化。
   * 返回 `reloadError` 让界面把两件事分开说。
   */
  async saveConfig(
    id: string,
    raw: unknown,
  ): Promise<{ config: PluginSettingsView; plugin: PluginView; reloadError: string | null }> {
    const rec = this.#find(id);
    if (!rec) throw new ApiError(`未知插件: ${id}`, 404);
    const pluginId = this.#configurableId(rec);
    if (rec.settings.error !== null) {
      throw new ApiError(
        `插件「${pluginId}」的 ${PLUGIN_SCHEMA_FILE} 有误：${rec.settings.error}`,
        400,
      );
    }

    const entries = validatePatch(rec.settings.fields, raw);
    if (entries.length === 0) {
      return { config: this.getConfig(pluginId), plugin: this.#view(rec), reloadError: null };
    }

    const dir = join(this.#storage.dataRoot, pluginId);
    const path = join(dir, PLUGIN_CONFIG_FILE);
    this.#storage.ensurePrivateDir(dir);
    let base: FileConfig = {};
    try {
      base = this.#storage.readConfigFileAt(path);
    } catch {
      // 坏文件：以表单值重建。GET 已经把 `configError` 摆在抽屉顶部，这是显式修复。
      base = {};
    }
    // `applyPatch` 只覆盖声明过的键，文件里用户手写的其它键原样保留。
    this.#storage.writeConfigFileAt(path, applyPatch(base, entries));

    let reloadError: string | null = null;
    if (rec.status === "active" || rec.status === "failed") {
      try {
        await this.reload(pluginId);
      } catch (err) {
        reloadError = errorMessage(err);
      }
    }

    const fresh = this.#find(pluginId) ?? rec;
    return {
      config: this.getConfig(pluginId),
      plugin: this.#view(fresh),
      reloadError,
    };
  }

  /**
   * 配置端点共用的两条前提：能按 id 找回来的记录 + 真的有 schema。
   *
   * 返回 id 而不是 `void`：调用方随后要拿它拼路径，`rec.id` 在函数外又变回
   * `string | null`，再写一次判空就会多一个「理论上不可能」的分支。
   */
  #configurableId(rec: PluginRecord): string {
    if (rec.id === null) {
      throw new ApiError(`插件「${rec.meta.id}」没有成功声明 id，无法定位它的配置`, 400);
    }
    if (!rec.settings.present) {
      throw new ApiError(`插件「${rec.id}」没有声明配置项（缺少 ${PLUGIN_SCHEMA_FILE}）`, 400);
    }
    return rec.id;
  }

  /** `<dataRoot>/<pluginId>/config.json`。id 在加载时已过 `assertPluginDirName`，这里再挡一次路径。 */
  #configPath(id: string): string {
    assertPluginDirName(id);
    return join(this.#storage.dataRoot, id, PLUGIN_CONFIG_FILE);
  }

  /**
   * 交给插件的同伴视图（`ctx.plugins()`）—— **投影**，不是复用 `#view()`。
   *
   * 刻意少两个键：
   *
   * - `dir`：别的插件的磁盘路径。插件之间需要知道的是「有没有它、它开着吗」，
   *   不是它落在哪个目录。
   * - `error`：那是**第三方文本** —— 动态 import 的报错、插件自己抛的错都可能带着
   *   `resolve()` 之后的绝对路径，而同伴插件是另一份用户手写的 JS，不是操作者。
   *
   * 这两个键是给操作者的，走 `list()` → `GET /plugins`。少给而不是「给了也没关系」：
   * 插件是磁盘上用户手写的代码，一条新暴露的键要经过一次人的判断才出去 ——
   * 与 `pluginRuntimeConfig()` 那份配置白名单同一个规矩，测试里用键集合钉住。
   *
   * 失败记录也在这里出现，且 `enabled` 为 `false`：同伴需要知道的正是「别声称它的能力可用」，
   * 而那一个布尔就够了，为什么失败留给操作者。
   */
  #peers(): PluginInfo[] {
    return [...this.#records.values()].map((rec) => ({
      id: rec.meta.id,
      name: rec.meta.name,
      version: rec.meta.version,
      ...(rec.meta.description === undefined ? {} : { description: rec.meta.description }),
      enabled: rec.status === "active",
    }));
  }

  async unloadAll(): Promise<void> {
    for (const rec of this.#records.values()) {
      await this.#teardown(rec);
    }
    this.#records.clear();
  }
}
