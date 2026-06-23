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
}

/**
 * 一个 model provider 对应一个具体的 LLM 后端（OpenAI 兼容、Anthropic、
 * 本地运行时…）。provider 在运行时注册，绝不硬编码。
 */
export interface ProviderInfo {
  id: string;
  name: string;
  /** 该 provider 暴露的模型标识列表。 */
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
