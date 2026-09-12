import type { Logger } from "#core/logger.ts";
import { ApiError, errorMessage } from "#core/errors.ts";
import { readConfigFileAt, updateConfigFileAt, type ToolToggle } from "#config/file.ts";

/** ToolConfigStore 实际读写的配置键。 */
export interface ToolStoreConfig {
  /**
   * 必填，`null` 要写出来 —— 理由与 `ProviderStoreConfig.filePath` 同一条：
   * 漏传不该变成「开关看起来能点，但一次也存不下来」。
   */
  filePath: string | null;
  tools?: Record<string, ToolToggle>;
  maxToolSteps?: number;
}

/**
 * 单轮允许的工具步数上限。
 *
 * **本仓自选的数字，没有上游来源**：典型的「查一下再回答」是 2–3 步，这里留一倍余量。
 * 上限存在的唯一理由是防失控 —— 默认超时 120s（`provider/store.ts` 的
 * `DEFAULT_TIMEOUT_MS`）意味着 5 步最坏能把一条 SSE 连接占住约 10 分钟，
 * 再往高就不如让用户显式调 `maxToolSteps`。
 *
 * 导出给 `config/config.ts` 用，是为了让这个数字只写一处：
 * 解析默认值与非法兜底若各写一份，改一个忘一个就会出现「配置文件里的默认与代码的默认不同」。
 */
export const DEFAULT_MAX_TOOL_STEPS = 5;
/** 夹住配置值的上下界：写成 0 或 1e6 都是笔误，不该变成「立刻停」或「无限跑」。 */
const MIN_MAX_TOOL_STEPS = 1;
const MAX_MAX_TOOL_STEPS = 50;

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
 * 判据与 `ProviderConfigStore` 收成同一句：**`filePath` 为 `null` 时才读注入的 baseline；
 * 给了 `filePath`，那个文件就是唯一真相，文件不存在即读空。** 以前这里是「文件里有没有
 * `tools` 键」那道门 —— 多配置档之下它会让一份还没写过工具段的配置档读出别人的开关。
 */
export class ToolConfigStore {
  #filePath: string | null;
  #logger: Logger | undefined;
  #baseline: { tools: Record<string, ToolToggle>; maxToolSteps?: number };

  constructor(config: ToolStoreConfig, logger?: Logger) {
    this.#filePath = config.filePath;
    this.#logger = logger;
    this.#baseline = { tools: config.tools ?? {}, maxToolSteps: config.maxToolSteps };
  }

  /** 配置文件绝对路径；`null` 表示没有落盘位置（只读模式）。 */
  get filePath(): string | null {
    return this.#filePath;
  }

  /** 是否可写。只读模式下只能读注入进来的配置。 */
  get writable(): boolean {
    return this.#filePath !== null;
  }

  /**
   * 当前生效的 `{tools, maxToolSteps}`。
   *
   * 两个键都是**顶层键**：`maxToolSteps` 不能塞进 `tools` 段 —— 那一段的键是工具 id，
   * `{"tools":{"maxSteps":…}}` 会和一个真的叫 `maxSteps` 的工具撞名。
   */
  #current(): { tools: Record<string, ToolToggle>; maxToolSteps?: number } {
    if (this.#filePath === null) return { ...this.#baseline };
    const file = readConfigFileAt(this.#filePath);
    return { tools: file.tools ?? {}, maxToolSteps: file.maxToolSteps };
  }

  /**
   * **只认 `=== true`**：没写、写成 `"true"`、写成 `1` 都算禁用。
   *
   * 这与 `adapters` 的 `?.enabled !== false`（默认启用）刻意相反：少听一个端口是
   * 部署细节，而给模型多一件可做的事是能力授予，不该在没人看的地方默认发生。
   * 别把两处判据「统一」掉。
   */
  isEnabled(id: string): boolean {
    return this.#current().tools[id]?.enabled === true;
  }

  /** 配置里声明为启用的 id（顺序不保证，交给 `ToolRegistry.pick()` 按注册顺序排）。 */
  enabledIds(): string[] {
    return Object.entries(this.#current().tools)
      .filter(([, toggle]) => toggle?.enabled === true)
      .map(([id]) => id);
  }

  /**
   * 单轮允许的工具步数。非法值退回默认而不是抛错：
   * 这个数字写歪了不该让服务起不来，也不该被静默当成「没限制」。
   */
  maxSteps(): number {
    const raw = this.#current().maxToolSteps;
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      if (raw !== undefined) {
        this.#logger?.warn(
          `maxToolSteps 不是整数（${String(raw)}），退回 ${DEFAULT_MAX_TOOL_STEPS}`,
        );
      }
      return DEFAULT_MAX_TOOL_STEPS;
    }
    if (raw < MIN_MAX_TOOL_STEPS || raw > MAX_MAX_TOOL_STEPS) {
      const clamped = Math.min(MAX_MAX_TOOL_STEPS, Math.max(MIN_MAX_TOOL_STEPS, raw));
      this.#logger?.warn(`maxToolSteps=${raw} 超出可用范围，按 ${clamped} 执行`);
      return clamped;
    }
    return raw;
  }

  /**
   * 写下开关。校验在落盘之前：`updateConfigFileAt` 的 mutate 抛错时文件完全不被触碰。
   *
   * @param enabled 收 `unknown` 而不是 `boolean` —— 传进来的是 HTTP 请求体里的字段，
   *   让类型系统替它「预先收窄」就等于放弃这条运行时校验。
   */
  setEnabled(id: string, enabled: unknown): { id: string; enabled: boolean } {
    if (typeof enabled !== "boolean") {
      throw new ApiError("enabled 必须是布尔值", 400);
    }
    const filePath = this.#filePath;
    if (filePath === null) {
      throw new ApiError("当前配置没有落盘位置（config.filePath 为 null），无法保存工具开关", 400);
    }
    try {
      return updateConfigFileAt(filePath, (config) => {
        const tools = config.tools ?? {};
        // 展开保留工具自己段落里的其余键（`ToolToggle` 是开放类型，见 config/file.ts）。
        tools[id] = { ...tools[id], enabled };
        config.tools = tools;
        return { id, enabled };
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // 细节只进日志，不回客户端：`readConfigFileAt` 的错误消息里带着配置文件绝对路径。
      this.#logger?.error(`写入 ${filePath} 失败: ${errorMessage(err)}`);
      // `cause` 不能省：文案里明说「详情见服务端日志」，堆栈丢了原始错误就无从可查。
      throw new ApiError("保存工具开关失败，详情见服务端日志", 500, { cause: err });
    }
  }
}
