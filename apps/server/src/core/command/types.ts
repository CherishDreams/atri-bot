/**
 * 指令系统的类型层。
 *
 * 「指令」与「工具」在本仓是两个词、两套契约（AGENTS.md 的命名纪律）：
 * 工具是模型请求、本地执行、结果回喂；指令是**用户在聊天里敲的文本协议**——
 * 带唤醒前缀的消息先走指令匹配，命中即执行并把返回文本作为助手消息回复，
 * **完全不经过模型**。因此这里的形状比 `ToolDefinition` 简单得多：没有参数
 * JSON Schema（参数解析按空格 + 引号做，见 `parser.ts`），没有 internal 开关
 * （指令随注册它的插件启停自动进退，不做按档开关）。
 */

/** `all` 所有人可用；`admin` 仅管理员（配置档管理员名单，控制台来源视为管理员）。 */
export type CommandPermission = "all" | "admin";

/** 指令执行时收到的参数。 */
export interface CommandArgs {
  /** 去掉唤醒前缀与指令名之后的原始文本（已 trim）。 */
  raw: string;
  /** 按「空格拆分、成对引号内不算分隔」解析出的参数列表。 */
  args: string[];
}

/** 指令执行上下文：谁在哪份档的哪个会话里敲的。 */
export interface CommandContext {
  profileId: string;
  sessionId: string;
  /**
   * 这次匹配实际用的唤醒前缀（`wakePrefix` 配成空串时是缺省的 `/`）。
   * `/help` 之类的输出要回显指令名，显示成 `/help` 才是用户能照着敲的形状。
   */
  prefix: string;
  /**
   * 消息来源。`platform` = 适配器（发送人身份以 `senderId` 为准）；
   * `console` = 控制台（已通过登录鉴权，视为管理员）；cron 来源根本不做指令匹配。
   */
  source: "platform" | "console";
  /** 平台发送人 id；控制台来源为 `null`。 */
  senderId: string | null;
  /** 平台显示名；控制台来源为 `null`。 */
  senderName: string | null;
  /** 发送人是否这一档的管理员。控制台来源恒为 true。 */
  isAdmin: boolean;
}

/** 唤醒前缀的缺省值。`wakePrefix` 配成空串关闭群聊门槛时，指令仍按它识别。 */
export const DEFAULT_COMMAND_PREFIX = "/";

/**
 * 一条指令的定义。`name` 与别名匹配时**不区分大小写**，但不能含空白
 * （含空白会让参数解析的边界说不清）；允许中文，AstrBot 的中文别名习惯照搬。
 */
export interface CommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  /** 使用说明（参数怎么填），`help <指令名>` 的详情里显示；缺省时省略。 */
  usage?: string;
  permission?: CommandPermission;
  /** 返回值就是要回复的文本；抛错由引擎兜成固定中文提示。 */
  run(args: CommandArgs, ctx: CommandContext): Promise<string> | string;
}

/** 注册表里的一条：定义 + 它的注册来源（`builtin` 或插件 id）。 */
export interface CommandEntry {
  def: CommandDefinition;
  source: string;
}
