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
  /**
   * 消息条数。服务端在会话摘要里附带（SQL 计数），用于列表预览而不必搬运内容。
   *
   * 转成必填是库化之后才成立的：内存版靠 `messages.length` 算、类型上留了「可能没有」的余地；
   * 现在两条读路径都带 `message_count` 子查询，`create()` 也恒给 0，所以它**总在场**。
   */
  messageCount: number;
}

/**
 * 会话详情：摘要字段 + **一页**消息历史（默认最新 100 条，仍按插入序旧→新）。
 * 直接打开 /chat/:id 或刷新页面时靠它恢复最近那一页，更早的靠响应里的 `nextCursor` 往前翻；
 * 会话列表接口刻意只回摘要，不把全部内容搬过来。
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
  /**
   * 超时（毫秒）。与实现类的 `timeoutMs` 同名同单位，不做秒/毫秒换算。
   * 非流式是**总预算**，流式是**空闲上限**（连续无增量才断），理由见 README 的 provider 一节。
   */
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
  /**
   * 这个接入端**已启用**（`atri.config.json` 里没写 `enabled: false`）。
   * 注意它不等于「真的在收流量」—— 启用了但绑定不可用时也不会启动，
   * 那一半由 `bound` 说。
   */
  enabled: boolean;
  /** 它跑在哪份配置档上（`adapters.<id>.profile`）；没绑定为 `null`。 */
  profile: string | null;
  /**
   * 绑定的那份配置档此刻是否可用。`enabled === false` 时这一项没有意义（不会去启动它），
   * 但仍然照实算 —— 控制台要能在用户把档修好之后看到它变绿，而不是等启用之后才知道。
   */
  bound: boolean;
}

/**
 * 插件运行时状态。取值是**协议键**（它进 `openapi.json` 的 enum、进生成 SDK 的联合类型，
 * 是机器比对的那一侧），所以与 `ProviderInfo.type` 的 `openai`/`anthropic` 同一口径保持英文。
 *
 * - `active`：实例建好了，`setup()` 跑通了。
 * - `disabled`：操作者关掉的，元数据保留着以便再启用。
 * - `failed`：**上一次加载抛错了**。它既不是运行中也不是已禁用 —— 实例压根不存在，
 *   而目录还在磁盘上等一次重载。它是「上一次加载的结果」而不是持久属性：重启会重新扫描、
 *   重新判定，所以没有任何地方需要把它落盘。
 *
 * 与 `error` 取值不选同一个词是刻意的：同一个对象上已经有一个 `error: string | null` 字段，
 * `status === "error"` 与它并存会让「状态」和「原因」这两件事在 grep 与文档里混成一个词。
 *
 * 这三个取值与 `apps/server/openapi.json` 的 `components.schemas.PluginStatus` 是同一份，
 * 由 `apps/server/test/shared-types-vs-spec.test.ts` 绑住（取值集合与成员的必填性两个方向都比）。
 * 在它之前这里只有注释上的「改一处必须改两处」，而 dashboard 的类型来自规格、
 * server 的类型来自这里 —— 靠记忆力绑的契约迟早漂。
 */
export type PluginStatus = "active" | "disabled" | "failed";
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
  /**
   * 这个插件有没有可编辑的配置项（目录里有 `_conf_schema.json`）。
   *
   * `PluginView`（`GET /plugins` 以及重载 / 启用 / 保存配置的响应）会给出；
   * `ctx.plugins()` 的同伴视图是另一份投影，不含这个键（与不含 `dir` / `error` 同一条规矩）。
   */
  configurable?: boolean;
}

/**
 * 一颗可被模型调用的工具，以及它当前的启用状态。
 *
 * `enabled` 的默认语义与 `AdapterInfo` **相反**：适配器没写就启用（少听一个端口而已），
 * 工具是能力授予，必须在**这份配置档的文件**里显式写 `{"enabled": true}` 才生效 ——
 * 一次升级不该静默给模型新增能力。
 */
export interface ToolInfo {
  id: string;
  /** 控制台显示名；没有中文名时等于 id。 */
  name: string;
  enabled: boolean;
  /**
   * 给模型看的说明，控制台用它解释这颗工具是干什么的。**必填**：
   * `ToolDefinition.description` 本身就是 `string`（`core/tool/types.ts`），而插件不能
   * 注册工具，所以 `GET /tools` 里没有「这一条没有说明」这种响应 —— 以前标成可选，
   * dashboard 就为一个不可能的 `undefined` 写了一层判空（`shared-types-vs-spec.test.ts` 会抓）。
   */
  description: string;
}

/**
 * 一份配置档的**加载状态**。
 *
 * 只有两个取值，而且 `failed` 的含义很窄：**这份档自己的文件读不出 / 校验不过 /
 * 对象图建不起来**。档内部的失败不算 —— 源配的引用不存在的 provider 是
 * `ProviderInfo.loaded: false` + `error`，`setup()` 抛错的插件是 `PluginStatus: "failed"`。
 * 发明第三种「档整体红色」会把「你有一个模型没配好」也表达成「这份档坏了」，
 * 而那是两件必须分开说的事（`GET /providers` 带着失败条目就是同一个先例）。
 *
 * 与 `openapi.json` 的 `components.schemas.ProfileStatus` 是同一份，
 * 同样由 `shared-types-vs-spec.test.ts` 绑住（理由与 `PluginStatus` 那条完全一样）。
 */
export type ProfileStatus = "ready" | "failed";

/**
 * `GET /profiles` 的一项。
 *
 * `path` 是给操作者看的落盘位置（`<dataDir>/profiles/<id>/config.json`），
 * 而 `error` **只给操作者**：它来自配置文件读取的原文，里面带着绝对路径，
 * 所以任何走 5xx 或客户端的出口都不得直接把它发出去（见 `api/server.ts` 的 `fail()`）。
 *
 * 这里**没有** owner / 权限一类的字段：本仓只有单一管理员，加上那种字段会让人
 * 以为存在按配置档的细粒度授权，而它并不存在。
 */
export interface ProfileRecord {
  id: string;
  /** 给人看的名字；配置档没写 `name` 时等于 id。 */
  name: string;
  path: string;
  status: ProfileStatus;
  /** 加载失败的原因；正常为 `null`（不是「没有错误所以键缺席」）。 */
  error: string | null;
  /**
   * 这一档默认用哪个 provider **实例**（`providers.json` 里的那一个 id）。
   *
   * `null` 表示没配档级默认，此时用全局 `providers.default`。生效次序只有这两级，
   * 由该档的引擎在请求没带 `model` 时填 —— 供应商本身是部署级全局的，
   * 「哪一档默认用哪个模型」才是档的属性。
   */
  defaultProviderId: string | null;
}

/**
 * 一份配置档**此刻的可编辑内容**，配置工作台的草稿起点。
 *
 * 为什么要一个端点而不是让界面拼 `GET /tools` + `GET /plugins` + `GET /profiles`：
 * 那三份之间没有原子性 —— 两次请求之间恰好有人改了或新建了一份档，草稿的起点就是
 * 自相矛盾的，而下一次保存会把这份矛盾整个写回磁盘。一次读，四段同源。
 *
 * 它**不引入第二份真源**：每一段仍由各自的存储现算（工具与步数读这份档的文件、
 * 插件是运行态、`defaultProviderId` 来自装配），这个端点只做搬运。
 */
export interface ProfileConfig {
  id: string;
  /** 给人看的名字；配置档没写 `name` 时等于 id。 */
  name: string;
  /** 这一档默认的 provider **实例** id；`null` = 用全局 `providers.default`。 */
  defaultProviderId: string | null;
  /**
   * 单轮允许的工具步数，给的是**夹取后的生效值**（引擎实际用的那一个）。
   *
   * 不返回文件里的原值：那样会出现「界面写着 999、实际跑 50」，而这两个数在
   * 同一次读里都"没错" —— 只留一个数，界面无从说谎。
   */
  maxToolSteps: number;
  tools: ToolInfo[];
  plugins: PluginInfo[];
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
