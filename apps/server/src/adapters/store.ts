import { dirname } from "node:path";
import type { AdapterToggle } from "#config/file.ts";
import { ApiError, errorMessage } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";
import {
  adapterTemplate,
  assertAdapterId,
  isAdapterId,
  settingsFromLegacy,
  type AdapterSettings,
} from "./templates.ts";

/**
 * 运行期适配器实例。
 *
 * 与 `data/providers.json` 一样，这是**部署级运行期配置**：控制台写、服务端读。
 * `atri.config.json` 里的 `adapters` 只在 `data/adapters.json` 不存在时作为一次性迁移源。
 */
export interface AdapterEntryConfig {
  type: string;
  name?: string;
  enabled: boolean;
  profile: string;
  settings: AdapterSettings;
}

export interface AdapterStateIo {
  exists(filePath: string): boolean;
  ensureDir(dir: string): void;
  read(filePath: string): Record<string, unknown>;
  write(filePath: string, value: Record<string, unknown>): void;
}

export interface AdapterConfigStoreOptions {
  filePath: string;
  /** 旧版 `atri.config.json` 的 adapters 段，只在文件不存在时迁移一次。 */
  seed: Record<string, AdapterToggle>;
  logger: Logger;
  io: AdapterStateIo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone(config: AdapterEntryConfig): AdapterEntryConfig {
  return {
    ...config,
    ...(config.name === undefined ? {} : { name: config.name }),
    settings: { ...config.settings },
  };
}

/**
 * `data/adapters.json` 的读写与内存缓存。
 *
 * 单进程、同步写：与 `ProviderConfigStore` / `PluginManager.saveConfig` 同一条前提。
 * 文件权限交给注入的 `write`（`writeConfigFileAt` 原子写 + 0600），目录交给
 * `ensurePrivateDir`（0700）—— 里面可能有 NapCat 的 access token。
 *
 * 文件坏掉不阻止服务启动：从空表开始并记一条 error；控制台仍能重新添加。
 * 这与 provider 文件坏了退化成回声兜底是同一个判断：那一时刻服务必须活着。
 */
export class AdapterConfigStore {
  #entries = new Map<string, AdapterEntryConfig>();
  #filePath: string;
  #logger: Logger;
  #io: AdapterStateIo;
  #source: "file" | "seed" | "empty";

  constructor({ filePath, seed, logger, io }: AdapterConfigStoreOptions) {
    this.#filePath = filePath;
    this.#logger = logger;
    this.#io = io;

    if (io.exists(filePath)) {
      this.#source = "file";
      this.#load();
    } else if (Object.keys(seed).length > 0) {
      this.#seed(seed);
      this.#source = this.#entries.size > 0 ? "seed" : "empty";
      if (this.#entries.size > 0) {
        try {
          this.#persistEntries(this.#entries);
        } catch (err) {
          this.#logger.error(
            `迁移适配器配置失败（本次仍按内存中的配置运行）：${errorMessage(err)}`,
          );
        }
      }
    } else {
      this.#source = "empty";
    }
  }

  /** 这一份内存表是从文件、旧配置迁移来的，还是空启动。装配处用它打一条可读的日志。 */
  get source(): "file" | "seed" | "empty" {
    return this.#source;
  }

  list(): { id: string; config: AdapterEntryConfig }[] {
    return [...this.#entries.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([id, config]) => ({ id, config: clone(config) }));
  }

  get(id: string): AdapterEntryConfig | null {
    const found = this.#entries.get(id);
    return found === undefined ? null : clone(found);
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  create(id: string, config: AdapterEntryConfig): void {
    assertAdapterId(id);
    if (this.#entries.has(id)) throw new ApiError(`适配器「${id}」已经存在`, 409);
    const next = new Map(this.#entries);
    next.set(id, clone(config));
    // 先落盘、再换内存：写失败时 API 会回 5xx，而 `list()` 必须仍然说旧话，
    // 否则后续请求会看见一条从未成功保存过的适配器。
    this.#persistEntries(next);
    this.#entries = next;
  }

  replace(id: string, config: AdapterEntryConfig): void {
    if (!this.#entries.has(id)) throw new ApiError(`未知适配器: ${id}`, 404);
    const next = new Map(this.#entries);
    next.set(id, clone(config));
    this.#persistEntries(next);
    this.#entries = next;
  }

  remove(id: string): void {
    if (!this.#entries.has(id)) throw new ApiError(`未知适配器: ${id}`, 404);
    const next = new Map(this.#entries);
    next.delete(id);
    this.#persistEntries(next);
    this.#entries = next;
  }

  setEnabled(id: string, enabled: boolean): void {
    const found = this.#entries.get(id);
    if (found === undefined) throw new ApiError(`未知适配器: ${id}`, 404);
    const next = new Map(this.#entries);
    next.set(id, { ...found, enabled });
    this.#persistEntries(next);
    this.#entries = next;
  }

  #load(): void {
    let raw: Record<string, unknown>;
    try {
      raw = this.#io.read(this.#filePath);
    } catch (err) {
      this.#logger.error(
        `读取适配器配置失败，将从空表开始（控制台可重新添加）：${errorMessage(err)}`,
      );
      return;
    }
    const adapters = isRecord(raw.adapters) ? raw.adapters : {};
    for (const [id, value] of Object.entries(adapters)) {
      const config = this.#normalize(id, value);
      if (config !== null) this.#entries.set(id, config);
    }
  }

  #normalize(id: string, raw: unknown): AdapterEntryConfig | null {
    if (!isRecord(raw)) {
      this.#logger.warn(`适配器「${id}」的配置不是对象，已忽略`);
      return null;
    }
    const type = typeof raw.type === "string" ? raw.type : "";
    if (adapterTemplate(type) === null) {
      this.#logger.warn(`适配器「${id}」的类型「${type}」不受支持，已忽略`);
      return null;
    }
    if (!isAdapterId(id)) {
      this.#logger.warn(`适配器「${id}」的 id 不能用作目录名，已忽略`);
      return null;
    }
    const settings = isRecord(raw.settings) ? raw.settings : {};
    return {
      type,
      ...(typeof raw.name === "string" && raw.name.trim() !== "" ? { name: raw.name.trim() } : {}),
      enabled: raw.enabled !== false,
      profile: typeof raw.profile === "string" ? raw.profile : "",
      settings: settingsFromLegacy(type, { ...raw, ...settings }),
    };
  }

  #seed(seed: Record<string, AdapterToggle>): void {
    for (const [id, toggle] of Object.entries(seed)) {
      if (!isAdapterId(id)) {
        this.#logger.warn(`旧配置里的适配器「${id}」id 不合法，未迁移`);
        continue;
      }
      // 旧配置没有 type：id 是当时唯一的类型键（例如 "napcat"）。只有能对上模板的才迁移。
      const type = typeof toggle.type === "string" ? toggle.type : id;
      if (adapterTemplate(type) === null) {
        this.#logger.warn(
          `旧配置里的适配器「${id}」（type=${type}）没有对应实现，未迁移；如需保留请在新页面添加`,
        );
        continue;
      }
      this.#entries.set(id, {
        type,
        ...(typeof toggle.name === "string" && toggle.name.trim() !== ""
          ? { name: toggle.name.trim() }
          : {}),
        enabled: toggle.enabled !== false,
        profile: typeof toggle.profile === "string" ? toggle.profile : "",
        settings: settingsFromLegacy(type, toggle),
      });
    }
  }

  #persistEntries(entries: Map<string, AdapterEntryConfig>): void {
    this.#io.ensureDir(dirname(this.#filePath));
    this.#io.write(this.#filePath, { adapters: Object.fromEntries(entries) });
  }
}
