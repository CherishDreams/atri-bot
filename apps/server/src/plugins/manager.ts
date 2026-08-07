import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginInfo, PluginStatus } from "@atri/shared";
import type { Logger } from "../core/logger.ts";
import type { AppConfig } from "../config/index.ts";
import { ApiError, errorMessage } from "../core/errors.ts";
import { PluginContext, type PluginContextConfig } from "./context.ts";

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
 */
export interface PluginRuntimeConfig {
  pluginDirs: string[];
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

/** 运行时记录：模块之外由框架持有的那一份状态。 */
interface PluginRecord {
  id: string;
  dir: string;
  plugin: PluginDefinition;
  ctx: PluginContext | null;
  status: PluginStatus;
  error: string | null;
  meta: PluginMeta;
}

/** `shared.PluginInfo` 里没有 `error`，而列表接口要带它，所以这里是扩展而不是平行。 */
export type PluginView = PluginInfo & { error: string | null };

interface PluginMeta {
  id: string;
  name: string;
  version: string;
  description?: string;
  dir: string;
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

  config: PluginRuntimeConfig;
  logger: Logger;

  constructor(config: PluginRuntimeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /** 供插件使用的共享能力。 */
  get shared(): PluginShared {
    return { logger: this.logger, config: this.config };
  }

  async loadAll(): Promise<void> {
    for (const dir of this.config.pluginDirs) {
      await this.#scanDir(dir);
    }
    const active = [...this.#records.values()].filter((r) => r.status === "active");
    this.logger.info(`已加载 ${active.length} 个插件`);
  }

  async #scanDir(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir);
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
      await this.load(pluginDir);
    }
  }

  /** 加载（或重新加载）某个插件目录，返回其对外元数据。 */
  async load(pluginDir: string): Promise<PluginView> {
    const dir = resolve(pluginDir);
    const module = await this.#importFresh(join(dir, "index.js"));
    // 插件是用户手写的 JS，模块形状只能在运行时收窄：默认导出优先，
    // 工厂写法先调用它拿到定义，然后统一由下面的 `!plugin?.id` 守卫把关。
    const exported: unknown = module.default ?? module;
    const plugin = (
      typeof exported === "function" ? await exported(this.shared) : exported
    ) as PluginDefinition;
    if (!plugin?.id) {
      throw new Error(`插件缺少 id: ${dir}`);
    }
    const id = plugin.id;

    // 同 id 已在运行则先销毁旧实例，避免重复。
    const existing = this.#records.get(id);
    if (existing) await this.#teardown(existing);

    const ctx = new PluginContext({
      id,
      logger: this.logger,
      config: { ...this.config, ...plugin.config },
    });

    try {
      await plugin.setup?.(ctx);
    } catch (err) {
      await ctx.dispose();
      throw new Error(`插件 ${id} 初始化失败: ${errorMessage(err)}`, { cause: err });
    }

    const record: PluginRecord = {
      id,
      dir,
      plugin,
      ctx,
      status: "active",
      error: null,
      meta: {
        id,
        name: plugin.name ?? id,
        version: plugin.version ?? "0.0.0",
        description: plugin.description,
        dir: basename(dir),
      },
    };
    this.#records.set(id, record);
    this.logger.info(`插件已加载: ${id}`);
    // 直接视图化刚建好的那份记录：`#records.get()` 在类型上可能为空，
    // 而这里注定存在，握着引用比再查一次更清楚。
    return this.#view(record);
  }

  /** 重载单个插件：销毁旧实例 -> 重新 import 模块 -> 创建新实例。 */
  async reload(id: string): Promise<PluginView> {
    const rec = this.#records.get(id);
    if (!rec) throw new ApiError(`未知插件: ${id}`, 404);
    this.logger.info(`正在重载插件: ${id}`);
    await this.#teardown(rec);
    return this.load(rec.dir);
  }

  /** 卸载单个插件：释放副作用并销毁实例，从管理器中移除。 */
  async unload(id: string): Promise<{ id: string; unloaded: boolean }> {
    const rec = this.#records.get(id);
    if (!rec) throw new ApiError(`未知插件: ${id}`, 404);
    await this.#teardown(rec);
    this.#records.delete(id);
    this.logger.info(`插件已卸载: ${id}`);
    return { id, unloaded: true };
  }

  /**
   * 启用/禁用插件。
   * 禁用 = 释放副作用、标记为 disabled（保留元数据以便再启用）；
   * 启用 = 从原目录重新加载。
   */
  async setEnabled(id: string, enabled: boolean): Promise<PluginView> {
    const rec = this.#records.get(id);
    if (!rec) throw new ApiError(`未知插件: ${id}`, 404);

    if (enabled) {
      if (rec.status === "active") return this.#view(rec);
      return this.load(rec.dir);
    }

    if (rec.status === "disabled") return this.#view(rec);
    await this.#teardown(rec);
    rec.status = "disabled";
    rec.ctx = null;
    this.logger.info(`插件已禁用: ${id}`);
    return this.#view(rec);
  }

  /** 释放一个记录的运行时资源（teardown + 逆序 effect），保留记录本身。 */
  async #teardown(rec: PluginRecord): Promise<void> {
    try {
      await rec.plugin.teardown?.();
    } catch (err) {
      this.logger.warn(`插件 ${rec.id} teardown 失败: ${errorMessage(err)}`);
    }
    await rec.ctx?.dispose();
  }

  /** 用带版本参数的 URL 重新 import，绕过 ESM 模块缓存。 */
  async #importFresh(entryPath: string): Promise<Record<string, unknown>> {
    const url = `${pathToFileURL(entryPath).href}?v=${++this.#revision}`;
    // 动态 import 的返回类型在这里就是未定的：插件是用户手写的 JS。
    // 真正的收窄发生在下面（`module.default ?? module` + `!plugin?.id` 守卫）。
    return import(url);
  }

  get(id: string): PluginView | null {
    const rec = this.#records.get(id);
    return rec ? this.#view(rec) : null;
  }

  list(): PluginView[] {
    return [...this.#records.values()].map((r) => this.#view(r));
  }

  #view(rec: PluginRecord): PluginView {
    return {
      ...rec.meta,
      status: rec.status,
      enabled: rec.status === "active",
      error: rec.error,
    };
  }

  async unloadAll(): Promise<void> {
    for (const rec of this.#records.values()) {
      await this.#teardown(rec);
    }
    this.#records.clear();
  }
}
