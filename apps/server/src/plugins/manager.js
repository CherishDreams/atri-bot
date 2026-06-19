import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 从磁盘加载插件。一个插件是一个目录，内含 `index.js`，
 * 默认导出 `{ id, name, version, setup(ctx) }`。
 * 插件是预期由用户编写的扩展点 —— 尽量保持这个契约精简。
 */
export class PluginManager {
  /** @type {Map<string, object>} */
  #plugins = new Map();
  /** @type {Map<string, object>} */
  #meta = new Map();

  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  get context() {
    // 插件收到的上下文。要有意识地扩展；这里的每个字段都是 API。
    return {
      logger: this.logger,
      config: this.config,
    };
  }

  async loadAll() {
    for (const dir of this.config.pluginDirs ?? []) {
      await this.#loadDir(dir);
    }
    this.logger.info(`已加载 ${this.#plugins.size} 个插件`);
  }

  async #loadDir(dir) {
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

      try {
        const mod = await import(pathToFileURL(resolve(entry)).href);
        await this.#register(mod.default ?? mod, pluginDir);
      } catch (err) {
        this.logger.error(`加载插件失败（${pluginDir}）: ${err.message}`);
      }
    }
  }

  async #register(plugin, pluginDir) {
    if (!plugin?.id) {
      this.logger.warn(`跳过缺少 id 的插件（${pluginDir}）`);
      return;
    }
    await plugin.setup?.(this.context);
    this.#plugins.set(plugin.id, plugin);
    this.#meta.set(plugin.id, {
      id: plugin.id,
      name: plugin.name ?? plugin.id,
      version: plugin.version ?? "0.0.0",
      description: plugin.description,
      enabled: true,
    });
    this.logger.debug(`插件就绪: ${plugin.id}`);
  }

  list() {
    return [...this.#meta.values()];
  }

  async unloadAll() {
    for (const [id, plugin] of this.#plugins) {
      try {
        await plugin.teardown?.();
      } catch (err) {
        this.logger.warn(`插件 ${id} 卸载失败: ${err.message}`);
      }
    }
    this.#plugins.clear();
    this.#meta.clear();
  }
}
