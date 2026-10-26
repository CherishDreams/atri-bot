/**
 * MCP 服务器的配置存储：`data/mcp.json`（部署级运行期资源，0600）。
 *
 * 形状与语义照搬 `adapters/store.ts`（io 注入 + 启停 + 增删改），因为它们是同一种东西：
 * 「部署级的外部连接清单，控制台是唯一写入口，改完立刻生效」。不搬 `providers/store.ts`
 * 的种子迁移 —— MCP 是新资源，没有历史遗留。
 *
 * `env` 与 `headers` 是**明文密钥**：与 providers 的 `apiKey` 同一条纪律，
 * 配置接口在鉴权闸门内原样回给管理员，但**任何日志与错误文本都不得携带它们**。
 */
import type { Logger } from "#core/logger.ts";
import { ApiError, errorMessage } from "#core/errors.ts";
import type { FileConfig } from "#config/file.ts";

/** MCP 服务器的三种传输。stdio 由本进程拉起子进程；http/sse 是远程端点。 */
export type McpTransport = "http" | "sse" | "stdio";

export interface McpServerEntry {
  /** 服务器 id：工具 id 的前缀（`mcp.<id>.<tool>`），必须过插件 id 同款正则。 */
  id: string;
  /** 显示名；缺省用 id。 */
  name?: string;
  transport: McpTransport;
  /** `http` / `sse` 的端点 URL。 */
  url?: string;
  /** `stdio` 的可执行命令（如 `node`、`npx`）。 */
  command?: string;
  /** `stdio` 的命令参数。 */
  args?: string[];
  /** `stdio` 子进程的额外环境变量（密钥常在这）。 */
  env?: Record<string, string>;
  /** `http` / `sse` 的附加请求头（token 常在这）。 */
  headers?: Record<string, string>;
  /** 禁用的服务器不连接、工具不进注册表。 */
  enabled?: boolean;
  /** 单次 tools/call 的超时（毫秒），缺省 60_000、上限 600_000。 */
  timeoutMs?: number;
}

export interface McpStateIo {
  exists(filePath: string): boolean;
  ensureDir(dirPath: string): void;
  read(filePath: string): FileConfig;
  write(filePath: string, config: FileConfig): string;
}

const MCP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const MAX_CALL_TIMEOUT_MS = 600_000;

export function assertMcpId(id: string): string {
  if (typeof id !== "string" || !MCP_ID_PATTERN.test(id)) {
    throw new ApiError(
      `MCP 服务器 id「${String(id)}」不合法：只允许小写字母、数字与 . _ -，` +
        `首字符必须是字母或数字，长度 1–32`,
      400,
    );
  }
  return id;
}

export function validMcpTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_CALL_TIMEOUT_MS;
  }
  return Math.min(value, MAX_CALL_TIMEOUT_MS);
}

/** 写入口的严格校验：transport 决定哪些键必须有哪些、哪些必须没有。 */
export function validateMcpEntry(raw: unknown): McpServerEntry {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("MCP 服务器配置必须是对象", 400);
  }
  const record = raw as Record<string, unknown>;
  const id = assertMcpId(typeof record.id === "string" ? record.id : "");
  const transport = record.transport;
  if (transport !== "http" && transport !== "sse" && transport !== "stdio") {
    throw new ApiError(`MCP 服务器「${id}」的 transport 必须是 http / sse / stdio`, 400);
  }
  const entry: McpServerEntry = { id, transport };
  if (record.name !== undefined) {
    if (typeof record.name !== "string")
      throw new ApiError(`MCP 服务器「${id}」的 name 必须是字符串`, 400);
    entry.name = record.name;
  }
  if (transport === "stdio") {
    if (typeof record.command !== "string" || record.command.trim() === "") {
      throw new ApiError(`MCP 服务器「${id}」的 stdio 传输必须提供 command`, 400);
    }
    entry.command = record.command.trim();
    if (record.args !== undefined) {
      if (!Array.isArray(record.args) || !record.args.every((a) => typeof a === "string")) {
        throw new ApiError(`MCP 服务器「${id}」的 args 必须是字符串数组`, 400);
      }
      entry.args = record.args;
    }
    if (record.env !== undefined) entry.env = stringMap(record, "env", id);
  } else {
    if (typeof record.url !== "string" || !/^https?:\/\//.test(record.url)) {
      throw new ApiError(`MCP 服务器「${id}」的 ${transport} 传输必须提供 http(s) URL`, 400);
    }
    entry.url = record.url;
    if (record.headers !== undefined) entry.headers = stringMap(record, "headers", id);
  }
  // stdio 也允许带 headers？不 —— 它没有 HTTP 层，写了只会让人以为它生效。
  if (record.headers !== undefined && transport === "stdio") {
    throw new ApiError(`MCP 服务器「${id}」是 stdio 传输，不接受 headers`, 400);
  }
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== "boolean") {
      throw new ApiError(`MCP 服务器「${id}」的 enabled 必须是布尔值`, 400);
    }
    entry.enabled = record.enabled;
  } else {
    entry.enabled = true;
  }
  if (record.timeoutMs !== undefined) {
    if (typeof record.timeoutMs !== "number" || !Number.isFinite(record.timeoutMs)) {
      throw new ApiError(`MCP 服务器「${id}」的 timeoutMs 必须是数字`, 400);
    }
    entry.timeoutMs = record.timeoutMs;
  }
  return entry;
}

function stringMap(
  record: Record<string, unknown>,
  key: string,
  id: string,
): Record<string, string> {
  const value = record[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(`MCP 服务器「${id}」的 ${key} 必须是字符串到字符串的映射`, 400);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string")
      throw new ApiError(`MCP 服务器「${id}」的 ${key}.${k} 必须是字符串`, 400);
    out[k] = v;
  }
  return out;
}

interface McpFileShape {
  servers?: Record<string, unknown>;
  [key: string]: unknown;
}

export class McpServerStore {
  #entries = new Map<string, McpServerEntry>();
  #filePath: string;
  #logger: Logger;
  #io: McpStateIo;

  constructor({ filePath, logger, io }: { filePath: string; logger: Logger; io: McpStateIo }) {
    this.#filePath = filePath;
    this.#logger = logger;
    this.#io = io;
    this.#load();
  }

  #load(): void {
    if (!this.#io.exists(this.#filePath)) return;
    try {
      const file = this.#io.read(this.#filePath) as McpFileShape;
      // 逐条 try/catch：一条坏配置不该让整份清单消失（与插件扫描同一条规矩）。
      for (const [key, raw] of Object.entries(file.servers ?? {})) {
        try {
          const entry = validateMcpEntry({ id: key, ...(raw as Record<string, unknown>) });
          this.#entries.set(entry.id, entry);
        } catch (err) {
          this.#logger.warn(`MCP 服务器「${key}」的配置无效，已跳过: ${errorMessage(err)}`);
        }
      }
    } catch (err) {
      // 坏文件从空表开始，但不静默：与适配器会话映射同一条处理。
      this.#logger.error(`MCP 服务器配置读不出来，按空清单处理: ${errorMessage(err)}`);
    }
  }

  #persist(): void {
    const servers: Record<string, McpServerEntry> = {};
    for (const entry of this.#entries.values()) servers[entry.id] = entry;
    this.#io.write(this.#filePath, { servers } as FileConfig);
  }

  list(): McpServerEntry[] {
    return [...this.#entries.values()].toSorted((a, b) => (a.id < b.id ? -1 : 1));
  }

  get(id: string): McpServerEntry | null {
    return this.#entries.get(id) ?? null;
  }

  create(raw: unknown): McpServerEntry {
    const entry = validateMcpEntry(raw);
    if (this.#entries.has(entry.id)) {
      throw new ApiError(`MCP 服务器「${entry.id}」已经存在`, 409);
    }
    this.#entries.set(entry.id, entry);
    this.#persist();
    return entry;
  }

  update(id: string, raw: unknown): McpServerEntry {
    const existing = this.#entries.get(id);
    if (!existing) throw new ApiError(`没有这个 MCP 服务器: ${id}`, 404);
    // 请求体是 JSON 边界交来的 unknown；validateMcpEntry 会重新做完整校验，
    // 这里展开只为把路径里的 id 钉进校验（id 不随 body 漂移）。
    const entry = validateMcpEntry({
      ...(raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}),
      id,
    });
    this.#entries.set(id, entry);
    this.#persist();
    return entry;
  }

  setEnabled(id: string, enabled: boolean): McpServerEntry {
    const entry = this.#entries.get(id);
    if (!entry) throw new ApiError(`没有这个 MCP 服务器: ${id}`, 404);
    entry.enabled = enabled;
    this.#persist();
    return entry;
  }

  remove(id: string): boolean {
    const removed = this.#entries.delete(id);
    if (removed) this.#persist();
    return removed;
  }
}
