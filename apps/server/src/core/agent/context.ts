/**
 * 引擎的「每轮上下文装配」接缝。
 *
 * system prompt 过去只有人格一份；记忆召回、时间感知、技能目录这类能力都需要
 * 「在每轮请求前往报头里塞一段自己的东西」。与其在引擎里为每一种能力写一个 if，
 * 不如把这个口子开成一个**有序的 provider 列表**：每个 provider 拿到本轮的事实
 * （谁、在哪个会话、说了什么），返回一段要注入的文本，或 null 表示本轮没有话说。
 *
 * 刻意的两个约束：
 * - **每轮一次**，不是每步一次：工具循环里每个请求都会重拼 system，但 provider
 *   只在循环开始前调用一次，结果在整轮内复用 —— 记忆召回这类可能要查库的操作
 *   不该随步数放大，也保证同轮内模型看到的那段话不变。
 * - **只进报头、不落库**：与人格同一条纪律，注入的段落没有「什么时候说过」的
 *   语义，落进历史详情就是一条假消息。
 */

/** 一轮对话开始时框架掌握的事实。 */
export interface TurnInfo {
  profileId: string;
  sessionId: string;
  /** 本轮用户输入（已 trim）。指令命中的轮不会走到 provider（根本不进模型）。 */
  userText: string;
  /** 平台发送人身份；控制台是登录用户名，cron 是 null。 */
  senderId: string | null;
  senderName: string | null;
  source: "platform" | "console" | "cron";
}

/**
 * 返回一段要拼进 system prompt 的文本（自带小标题，如 `【长期记忆】`）；
 * `null` / 空串表示本轮不注入。抛错由引擎吞掉并记 warn —— 装饰性上下文
 * 的失败不该让一轮对话失败。
 */
export type TurnContextProvider = (turn: TurnInfo) => Promise<string | null>;
