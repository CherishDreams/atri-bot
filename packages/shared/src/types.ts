/** 服务端与 dashboard 共享的核心领域类型。 */

export type Role = "system" | "user" | "assistant" | "tool";

/**
 * 消息里的一张图片。
 *
 * 存的是图片**本体**而不是一个会过期的 URL：QQ 的图片链接通常带时效性参数，
 * 只在会话里留链的话，历史消息过几个小时就变成破图，回喂给模型时也取不到。
 * `data` 是 base64（不含 `data:` 前缀），与 provider 两家的线协议都能直接换算。
 */
export interface MessageImage {
  /** base64 编码的图片字节。 */
  data: string;
  /** MIME 类型，如 `image/jpeg`。 */
  mediaType: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: Role;
  /** 文本内容。当消息纯粹是工具调用/结果、或只发了图片时为空。 */
  content: string;
  /** 用户消息附带的图片；纯文本消息没有这个键。 */
  images?: MessageImage[];
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
 * 一台 MCP 服务器的状态视图（`GET /mcp` 的元素）。
 *
 * MCP 是**部署级**资源（`data/mcp.json`），工具以 `mcp.<服务器 id>.<工具名>` 的
 * id 进各档的工具开关 —— 这一族端点因此不带 `?profile=`。「开哪些工具」由配置档
 * 的工具清单管，这里只管「有哪些服务器、连上没有、各自提供了什么」。
 */
export interface McpServerInfo {
  id: string;
  /** 显示名；没填时等于 id。 */
  name: string;
  /** `http`（Streamable HTTP）| `sse` | `stdio`（本机子进程）。 */
  transport: string;
  url?: string;
  command?: string;
  args?: string[];
  /**
   * 明文密钥可能在这里（stdio 的 env、http 的 headers）。与 providers 的 `apiKey`
   * 同一条纪律：鉴权闸门内原样回给管理员，日志与错误文本里永远不出现。
   */
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled: boolean;
  /** 单次工具调用超时（毫秒），夹取后的生效值。 */
  timeoutMs: number;
  /** `connected` | `error` | `disabled` | `idle`（配置了但还没试过连接）。 */
  status: string;
  /** 上一次连接失败的原因；正常为 null。 */
  error: string | null;
  /** 这台服务器当前提供的工具（连接成功后非空）。 */
  tools: { id: string; name: string; description: string }[];
}

/**
 * 适配器把外部界面（HTTP、QQ、Discord、WebSocket…）桥接到内部消息管线。
 * 刻意保持通用，这样纯 agent 部署完全不需要聊天平台。
 */
/** 计划任务最近一次执行的结果；从未执行时为 null。 */
export type CronLastStatus = "success" | "error";

/**
 * 一条计划任务。任务是**部署级**的，但每次执行使用 `profile` 指定的配置档；
 * 结果写进该任务自己的内部会话（`sessionId`），不会凭空发到外部平台。
 */
export interface CronJobInfo {
  id: string;
  name: string;
  /** 5 段 cron：分 时 日 月 周，按服务器本地时区。 */
  cron: string;
  /** 到点后作为用户消息发给引擎的内容。 */
  prompt: string;
  /** 用哪一份配置档的人格、模型与工具执行。 */
  profile: string;
  enabled: boolean;
  /** 任务专属的内部会话；第一次执行时创建。 */
  sessionId: string | null;
  lastRunAt: string | null;
  lastStatus: CronLastStatus | null;
  /** 最近一次失败的中文原因；成功或未执行时为 null。 */
  lastError: string | null;
  /** 下一次触发时间（ISO）；禁用或 cron 不可计算时为 null。 */
  nextRunAt: string | null;
  /** 此刻是否有一轮正在跑（手动或定时）。 */
  running: boolean;
}

/**
 * 可复用的人格。人格是**全局资源**，配置档只通过 `personaId` 引用它；
 * 提示词内容不随历史落库，而是在每次请求前作为 system 消息注入。
 */
export interface PersonaInfo {
  id: string;
  name: string;
  description: string;
  /** 给模型看的系统提示词。 */
  systemPrompt: string;
}

export interface AdapterAccessControl {
  /** 是否启用白名单。关闭时所有人都能触发。 */
  whitelistEnabled: boolean;
  /** 白名单：私聊用户 id 或群 id。 */
  allowedIds: string[];
  /** 管理员 id。管理员始终越过白名单，且不参与白名单校验。 */
  adminIds: string[];
}

export interface AdapterInfo {
  id: string;
  /** 显示名；没填时为 id。 */
  name: string;
  /** 适配器类型（目前只有 `napcat`），决定用哪套表单与哪个实现。 */
  type: string;
  /** 运行期配置里的启用开关。它不等于真的在跑：启动失败时 `running` 为 false。 */
  enabled: boolean;
  /** 绑定的配置档 id；没绑定为 `null`。 */
  profile: string | null;
  /** 绑定的那份配置档此刻是否可用。 */
  bound: boolean;
  /** 适配器实例是否已成功启动（NapCat 的 WebSocket 连接状态另见日志）。 */
  running: boolean;
  /** 上一次启动失败的原因；正常为 `null`。 */
  error: string | null;
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
 * 一条已注册指令的对外视图（`GET /commands` 的元素）。
 *
 * 指令与工具是两个词、两套注册表（AGENTS.md 的命名纪律）：指令是**文本协议**——
 * 用户在聊天里敲 `/help` 这类前缀消息触发、结果直接回复且完全不经过模型；
 * 工具是模型请求、本地执行、结果回喂的一次性动作。所以这里没有 `parameters`，
 * `source` 也只有「哪来的」（builtin / 插件 id），没有启用开关 —— 指令随它的插件启停
 * 自动进退，不做按档开关（要关指令就禁用那个插件）。
 */
export interface CommandInfo {
  /** 指令名（不含唤醒前缀）。匹配时不区分大小写。 */
  name: string;
  /** 别名（同样不含前缀），可为空数组。 */
  aliases: string[];
  description: string;
  /** 使用说明（参数怎么填）；缺省时省略。 */
  usage?: string;
  /** 权限：`all` 所有人可用；`admin` 仅管理员（平台管理员名单或控制台）。 */
  permission: "all" | "admin";
  /** 注册来源：`builtin` 或插件 id。 */
  source: string;
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
 * 一条技能（SKILL.md 文件夹）的目录项。
 *
 * 技能是**部署级**的文件资源（`<dataDir>/skills/` 或插件目录捆绑），
 * 配置档只存「启用了哪些」。运行时渐进式披露：报头里只有名字与说明，
 * 全文由模型按需用 `read_skill` 工具取。
 */
export interface SkillInfo {
  id: string;
  /** frontmatter 的 name；缺省用目录名。 */
  name: string;
  /** frontmatter 的 description。 */
  description: string;
  /** `skills`（部署级目录）或插件目录名。 */
  source: string;
}

/**
 * 一份配置档的拟人化设置（生效值）。
 *
 * 这些是**被动**的对话行为调节：不改变回复内容的生产方式（那仍是引擎的事），
 * 只调节「怎么收消息、怎么发出去」。主动消息（proactive）是另一段，见下。
 */
export interface HumanizerConfig {
  /**
   * 连续输入防抖的沉默窗口（秒）。窗口内同会话的多条消息合并成一轮再回复；
   * 0 = 关闭。默认 0（不改变既有行为）。
   */
  debounceSeconds: number;
  /** 发送到平台前按句子智能分段（多条短消息更像人）。默认 true。 */
  smartChunk: boolean;
  /** 发送到平台前剥掉 markdown 标记（**、#、` 等，IM 里它们看着像机器）。默认 false。 */
  stripMarkdown: boolean;
  /** 每轮注入当前时间/星期/日程状态。默认 true。 */
  timeAwareness: boolean;
  /** 作息日程：时间感知与主动消息都按它判断此刻的状态。 */
  schedule: {
    /** 入睡时间（HH:MM，服务器本地时区）。空串 = 不睡觉。 */
    sleepStart: string;
    /** 起床时间（HH:MM）。 */
    sleepEnd: string;
    /** 午休分钟数（从 13:00 开始）；0 = 不午休。 */
    napMinutes: number;
  };
  /**
   * 主动消息（拟人化的另一半，见 core/companion/proactive.ts）：空闲/日程触发，
   * 经免打扰时段、每日上限等闸门后才发送。默认整体关闭。
   */
  proactive: {
    enabled: boolean;
    /** 私聊空闲多久后可以主动问候（分钟）。 */
    idleMinutes: number;
    /** 每天最多主动发几条（每份档全局计数）。 */
    maxPerDay: number;
    /** 免打扰时段起点（HH:MM）——此段内不发任何主动消息。 */
    quietStart: string;
    /** 免打扰时段终点（HH:MM）。 */
    quietEnd: string;
  };
}

/**
 * 一份配置档的记忆设置（生效值，缺省已由服务端补齐）。
 *
 * 记忆是「可替换组件」的样板：`provider` 指向 `builtin`（内置实现）或某个插件
 * 声明的记忆供应商。一次请求只选一个 provider，指到不存在的 id 时不降级 ——
 * 静默换方案的症状是「记忆忽好忽坏而配置没变」。
 */
export interface MemoryConfig {
  /** 是否启用记忆注入与自动记录。默认 true。 */
  enabled: boolean;
  /** 用哪个记忆供应商：`builtin` 或插件 provider id。默认 `builtin`。 */
  provider: string;
  /** 每轮注入的记忆条数上限（1–10）。默认 3。 */
  topK: number;
  /** 是否把每轮交互自动存为一条记忆（interaction）。默认 true。 */
  autoRecord: boolean;
}

/**
 * 一份配置档**此刻的可编辑内容**，配置工作台的草稿起点。
 *
 * 为什么要一个端点而不是让界面拼 `GET /tools` + `GET /plugins` + `GET /profiles`：
 * 那三份之间没有原子性 —— 两次请求之间恰好有人改了或新建了一份档，草稿的起点就是
 * 自相矛盾的，而下一次保存会把这份矛盾整个写回磁盘。一次读，各段同源。
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
  /** 这一档选用的人格 id；`null` = 不注入人格提示。 */
  personaId: string | null;
  /**
   * 单轮允许的工具步数，给的是**夹取后的生效值**（引擎实际用的那一个）。
   *
   * 不返回文件里的原值：那样会出现「界面写着 999、实际跑 50」，而这两个数在
   * 同一次读里都"没错" —— 只留一个数，界面无从说谎。
   */
  maxToolSteps: number;
  /**
   * 群聊唤醒前缀（生效值）。空串 = 关闭群聊唤醒门槛；此时指令仍按 `/` 识别。
   * 私聊永远不设门槛。
   */
  wakePrefix: string;
  /** 这一档的记忆设置（生效值）。 */
  memory: MemoryConfig;
  /**
   * 这一档可选的记忆供应商 id 清单：恒含 `builtin`，其余是**当前运行中**的插件
   * 声明的。它不是档文件的键 —— 是给配置页画 provider 下拉框的现算清单，
   * 插件启停后跟着变。
   */
  memoryProviders: string[];
  /**
   * 这一档启用的技能 id 清单（生效值）。空数组 = 一个都不注入。
   * 技能本体是部署级文件，`availableSkills` 是给界面画勾选列表的现算目录。
   */
  skills: { enabled: string[] };
  /** 部署级当前可用的全部技能（含插件捆绑的），与 `GET /skills` 同源。 */
  availableSkills: SkillInfo[];
  /** 这一档的拟人化设置（生效值）。 */
  humanizer: HumanizerConfig;
  tools: ToolInfo[];
  plugins: PluginInfo[];
  /**
   * 这一档的准入控制。**按配置档一份**：绑定到这一档的所有适配器共用它，
   * 换一档就是另一张名单。不是适配器实例的属性 —— 适配器只是这份跑法的入口。
   */
  access: AdapterAccessControl;
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

/** 程序日志的级别，与 `createLogger` 的四档一致。 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * 日志页看到的一行。
 *
 * `id` 在**同一个服务端进程**内单调递增，客户端用它去重、以及在 SSE 重连时带
 * `after` 续传。服务重启后序号从头开始，所以客户端发现最新 id 比自己手里的小时
 * 必须整份刷新，不能拿旧 id 继续订阅。
 */
export interface LogEntry {
  /** 产生这一行的进程实例。服务重启后会变，客户端据此丢弃旧的续传水位。 */
  instance: string;
  id: number;
  /** ISO 8601。 */
  time: string;
  level: LogLevel;
  message: string;
}
