import { readdir, stat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { PluginContext } from "./context.js";

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
 *
 * 插件契约（`index.js` 默认导出）：
 *   { id, name?, version?, description?, config?, setup?(ctx), teardown?() }
 * 也支持默认导出一个工厂函数 `(shared) => 上述对象`。
 */
export class PluginManager {
  /** @type {Map<string, object>} 插件 id -> 运行时记录 */
  #records = new Map();
  /** 带自增序号的缓存击穿计数器，保证每次重载都能拿到新代码 */
  #revision = 0;

  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  /** 供插件使用的共享能力。 */
  get shared() {
    return { logger: this.logger, config: this.config };
  }

  async loadAll() {
    for (const dir of this.config.pluginDirs ?? []) {
      await this.#scanDir(dir);
    }
    const active = [...this.#records.values()].filter((r) => r.status === "active");
    this.logger.info(`已加载 ${active.length} 个插件`);
  }

  async #scanDir(dir) {
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
      const entry = join(pluginDir, "index.js");
      const ok = await stat(entry).catch(() => null);
      if (!ok) continue;
      await this.load(pluginDir);
    }
  }

  /** 加载（或重新加载）某个插件目录，返回其对外元数据。 */
  async load(pluginDir) {
    const dir = resolve(pluginDir);
    const module = await this.#importFresh(join(dir, "index.js"));
    const def = module.default ?? module;

    const plugin = typeof def === "function" ? await def(this.shared) : def;
    if (!plugin?.id) {
      throw new Error(`插件缺少 id: ${dir}`);
    }
    const id = plugin.id;

    // 同 id 已在运行则先销毁旧实例，避免重复。
    if (this.#records.has(id)) {
      await this.#teardown(this.#records.get(id));
    }

    const ctx = new PluginContext({
      id,
      logger: this.logger,
      config: { ...this.config, ...plugin.config },
    });

    try {
      await plugin.setup?.(ctx);
    } catch (err) {
      await ctx.dispose();
      throw new Error(`插件 ${id} 初始化失败: ${err.message}`, { cause: err });
    }

    this.#records.set(id, {
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
    });
    this.logger.info(`插件已加载: ${id}`);
    return this.#view(this.#records.get(id));
  }

  /** 重载单个插件：销毁旧实例 -> 重新 import 模块 -> 创建新实例。 */
  async reload(id) {
    const rec = this.#records.get(id);
    if (!rec) throw new Error(`未知插件: ${id}`);
    this.logger.info(`正在重载插件: ${id}`);
    await this.#teardown(rec);
    return this.load(rec.dir);
  }

  /** 卸载单个插件：释放副作用并销毁实例，从管理器中移除。 */
  async unload(id) {
    const rec = this.#records.get(id);
    if (!rec) throw new Error(`未知插件: ${id}`);
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
  async setEnabled(id, enabled) {
    const rec = this.#records.get(id);
    if (!rec) throw new Error(`未知插件: ${id}`);

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
  async #teardown(rec) {
    try {
      await rec.plugin.teardown?.();
    } catch (err) {
      this.logger.warn(`插件 ${rec.id} teardown 失败: ${err.message}`);
    }
    await rec.ctx?.dispose();
  }

  /** 用带版本参数的 URL 重新 import，绕过 ESM 模块缓存。 */
  async #importFresh(entryPath) {
    const url = `${pathToFileURL(entryPath).href}?v=${++this.#revision}`;
    return import(url);
  }

  get(id) {
    const rec = this.#records.get(id);
    return rec ? this.#view(rec) : null;
  }

  list() {
    return [...this.#records.values()].map((r) => this.#view(r));
  }

  #view(rec) {
    return {
      ...rec.meta,
      status: rec.status,
      enabled: rec.status === "active",
      error: rec.error,
    };
  }

  async unloadAll() {
    for (const rec of this.#records.values()) {
      await this.#teardown(rec);
    }
    this.#records.clear();
  }
}
