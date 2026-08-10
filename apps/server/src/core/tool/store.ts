import type { Logger } from "../logger.ts";
import { ApiError, errorMessage } from "../errors.ts";
import {
  configFilePath,
  readConfigFile,
  updateConfigFile,
  type ToolToggle,
} from "../../config/file.ts";

/** ToolConfigStore 实际读写的配置键。 */
export interface ToolStoreConfig {
  root?: string;
  tools?: Record<string, ToolToggle>;
}

/**
 * 工具开关的存储。所有方法都是同步的：配置是小文件，每次读-改-写的代价
 * 远低于缓存一份状态再去处理一致性。
 *
 * ## 为什么读的是文件，而不是注入进来的 `AppConfig`
 *
 * `AppConfig` 是 `loadConfig()` 在启动时的一次性快照，之后没有任何重读点。
 * 控制台的开关改的就是文件，所以「现在哪些工具启用」必须以文件为准，
 * 否则 `POST /tools/:id/enable` 成功之后 `GET /tools` 还在说旧话。
 * （`AdapterManager.list()` 正是从注入的那一份算 `enabled` —— 它今天没错，
 * 只因为没有任何代码在运行期改 `adapters`。抄它会抄进同一个潜伏 bug。）
 *
 * 判据是「文件里有没有 `tools` 键」而不是「文件是否存在」，这样用代码直接构造
 * config（测试、嵌入使用）时注入值仍然生效，不会把配置凭空读空。与
 * `ProviderConfigStore.#current()` 是同一条规矩。
 */
export class ToolConfigStore {
  #root: string | null;
  #logger: Logger | undefined;
  #baseline: Record<string, ToolToggle>;

  constructor(config: ToolStoreConfig, logger?: Logger) {
    this.#root = config.root ?? null;
    this.#logger = logger;
    this.#baseline = config.tools ?? {};
  }

  /** 配置文件绝对路径；没有 `root` 时为 null（只读模式）。 */
  get filePath(): string | null {
    return this.#root ? configFilePath(this.#root) : null;
  }

  /** 是否可写。没有 `root` 时只能读注入进来的配置。 */
  get writable(): boolean {
    return this.#root !== null;
  }

  #current(): Record<string, ToolToggle> {
    if (!this.#root) return { ...this.#baseline };
    const file = readConfigFile(this.#root);
    if (!Object.hasOwn(file, "tools")) return { ...this.#baseline };
    return file.tools ?? {};
  }

  /**
   * **只认 `=== true`**：没写、写成 `"true"`、写成 `1` 都算禁用。
   *
   * 这与 `adapters` 的 `?.enabled !== false`（默认启用）刻意相反：少听一个端口是
   * 部署细节，而给模型多一件可做的事是能力授予，不该在没人看的地方默认发生。
   * 别把两处判据「统一」掉。
   */
  isEnabled(id: string): boolean {
    return this.#current()[id]?.enabled === true;
  }

  /** 配置里声明为启用的 id（顺序不保证，交给 `ToolRegistry.pick()` 按注册顺序排）。 */
  enabledIds(): string[] {
    return Object.entries(this.#current())
      .filter(([, toggle]) => toggle?.enabled === true)
      .map(([id]) => id);
  }

  /**
   * 写下开关。校验在落盘之前：`updateConfigFile` 的 mutate 抛错时文件完全不被触碰。
   *
   * @param enabled 收 `unknown` 而不是 `boolean` —— 传进来的是 HTTP 请求体里的字段，
   *   让类型系统替它「预先收窄」就等于放弃这条运行时校验。
   */
  setEnabled(id: string, enabled: unknown): { id: string; enabled: boolean } {
    if (typeof enabled !== "boolean") {
      throw new ApiError("enabled 必须是布尔值", 400);
    }
    if (!this.#root) {
      throw new ApiError("当前配置没有落盘位置（config.root 未设置），无法保存工具开关", 400);
    }
    const filePath = this.filePath;
    try {
      return updateConfigFile(this.#root, (config) => {
        // 与 `#current()` 同一条键存在性判据：文件里还没写过 `tools` 段时，起点是
        // 注入进来的那一份（测试、嵌入式使用），否则一次落盘会把它们全部写没。
        const fromFile = config.tools ?? {};
        const tools = Object.hasOwn(config, "tools")
          ? fromFile
          : { ...this.#baseline, ...fromFile };
        // 展开保留工具自己段落里的其余键（`ToolToggle` 是开放类型，见 config/file.ts）。
        tools[id] = { ...tools[id], enabled };
        config.tools = tools;
        return { id, enabled };
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // 细节只进日志，不回客户端：`readConfigFile` 的错误消息里带着配置文件绝对路径。
      this.#logger?.error(`写入 ${filePath} 失败: ${errorMessage(err)}`);
      throw new ApiError("保存工具开关失败，详情见服务端日志", 500);
    }
  }
}
