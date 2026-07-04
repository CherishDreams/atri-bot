/** 服务端与 dashboard 共享的核心领域类型。 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  id: string;
  sessionId: string;
  role: Role;
  /** 文本内容。当消息纯粹是工具调用/结果时为空。 */
  content: string;
  /** 当 role === "assistant" 且模型请求了工具调用时存在。 */
  toolCalls?: ToolCall[];
  /** 当 role === "tool" 时存在：本条在回应哪个调用。 */
  toolCallId?: string;
  createdAt: string; // ISO 8601
}

export interface ToolCall {
  id: string;
  name: string;
  /** 模型产出的原始 JSON 参数。 */
  arguments: string;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 消息条数。服务端在会话摘要里附带，用于列表预览而不必搬运内容。 */
  messageCount?: number;
}

/**
 * 会话详情：摘要字段 + 完整消息历史。
 * 直接打开 /chat/:id 或刷新页面时靠它恢复对话，
 * 因此会话列表接口刻意只回摘要，不把全部内容搬过来。
 */
export interface SessionDetail extends Session {
  messages: Message[];
}

/**
 * 一个 provider source 是一次连接的描述：`baseUrl` / `apiKey` / `timeoutMs`。
 * 同一源下的多个模型共享这一份凭证与超时，因此改密钥只需改一处。
 *
 * 两层结构（源 + 模型实例）照搬 AstrBot，可以少发明一套语义。
 */
export interface ProviderSource {
  id: string;
  /** 实现类型：`openai`（OpenAI 兼容）或 `anthropic`。 */
  type: string;
  name: string;
  /** 空字符串表示用实现类的默认地址。 */
  baseUrl: string;
  /** 明文密钥。配置接口在鉴权闸门内，会把它原样回给管理员。 */
  apiKey: string;
  /** 超时（毫秒）。与实现类的 `timeoutMs` 同名同单位，不做秒/毫秒换算。 */
  timeoutMs: number;
}

/**
 * 配置层的一个模型实例（不是运行时对象）。
 *
 * `loaded` 是这里最容易被忽略、却最有用的字段：配置里写着不等于它真的能跑。
 * 缺源、类型拼错、引用了不存在的 source 都会让一条配置留在文件里但注册不上，
 * 界面必须能把这种状态显式画出来，否则用户会以为「保存成功了就没事」。
 */
export interface ProviderInfo {
  id: string;
  name: string;
  /** 上游的模型 ID。 */
  model?: string;
  /** 引用的 provider source id；内联老写法下没有这个字段。 */
  source?: string;
  /** 实现类型，如 openai / anthropic。 */
  type?: string;
  /** 是否启用。禁用的实例不出现在模型选择器里。 */
  enabled?: boolean;
  /** 是否为配置里的默认 provider。 */
  default?: boolean;
  /** 是否已成功注册进运行时。 */
  loaded?: boolean;
  /** 加载失败的原因；只有 `loaded` 为 false 时才有。 */
  error?: string;
}

/** 「获取模型列表」的响应。 */
export interface ProviderModelList {
  models: string[];
}

/**
 * 适配器把外部界面（HTTP、QQ、Discord、WebSocket…）桥接到内部消息管线。
 * 刻意保持通用，这样纯 agent 部署完全不需要聊天平台。
 */
export interface AdapterInfo {
  id: string;
  name: string;
  /** 适配器当前是否在接收流量。 */
  enabled: boolean;
}

/** 插件运行时状态。active=运行中，disabled=已禁用（保留元数据可再启用）。 */
export type PluginStatus = "active" | "disabled";

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  /** 运行时状态。 */
  status?: PluginStatus;
  /** 插件所在目录名，便于在控制台辨认。 */
  dir?: string;
}

/**
 * 已通过鉴权的账号。目前只有单一管理员，因此只有用户名；
 * 凭证本身从不进入响应体，一律走 HttpOnly Cookie。
 */
export interface AuthUser {
  username: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: AuthUser;
  /** 会话的绝对过期时间，ISO 8601。 */
  expiresAt: string;
}

/** 登录页据此决定是否需要展示登录表单。 */
export interface AuthStatus {
  required: boolean;
}
