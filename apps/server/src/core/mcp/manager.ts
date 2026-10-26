/**
 * MCP 客户端管理器：把「部署级的一份 MCP 服务器清单」变成**会说话的工具**。
 *
 * 生命周期模型与适配器同构：store 管配置，manager 管连接与工具桥接；
 * 工具经 `ToolRegistry.registerSource` 进各档的注册表，启用与否走既有的
 * 档工具开关 —— 不为 MCP 发明第二套开关。
 *
 * 工具 id 的形状是 `mcp.<serverId>.<toolName>`：跨服务器同名工具不打架，
 * 操作者从 id 就能看出这颗工具是谁提供的。远端名字可能不合规（大写、超长、
 * 特殊字符）—— 那种**跳过并 warn**，而不是改名硬塞（改了名的 id 会在
 * 「模型调了但查无此工具」这类排查里说谎）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolDefinition } from "#core/tool/types.ts";
import type { Logger } from "#core/logger.ts";
import { errorMessage } from "#core/errors.ts";
import { McpServerStore, validMcpTimeout, type McpServerEntry } from "./store.ts";

const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** tools/list 的超时（毫秒）。本仓自选值：列清单比执行一次调用轻得多。 */
const LIST_TIMEOUT_MS = 15_000;

export type McpServerStatus = "connected" | "error" | "disabled" | "idle";

interface Connection {
  client: Client;
  status: McpServerStatus;
  error: string | null;
  tools: RemoteTool[];
}

interface RemoteTool {
  id: string;
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerView {
  id: string;
  name: string;
  transport: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled: boolean;
  timeoutMs: number;
  status: McpServerStatus;
  error: string | null;
  tools: { id: string; name: string; description: string }[];
}

export class McpManager {
  readonly #store: McpServerStore;
  readonly #logger: Logger;
  /** id -> 连接。**含 error 与 disabled 状态**：诊断要在重启之后仍然看得见。 */
  #connections = new Map<string, Connection>();

  constructor({ store, logger }: { store: McpServerStore; logger: Logger }) {
    this.#store = store;
    this.#logger = logger;
  }

  get store(): McpServerStore {
    return this.#store;
  }

  /** 连接所有启用的服务器。一颗失败不拖垮别人（与插件扫描同一条规矩）。 */
  async startAll(): Promise<void> {
    for (const entry of this.#store.list()) {
      if (entry.enabled === false) {
        this.#connections.set(entry.id, {
          client: null as unknown as Client,
          status: "disabled",
          error: null,
          tools: [],
        });
        continue;
      }
      await this.connect(entry).catch(() => {
        /* connect 内部已把失败记进连接表 */
      });
    }
  }

  async stopAll(): Promise<void> {
    for (const [id, connection] of this.#connections) {
      try {
        await connection.client?.close();
      } catch (err) {
        this.#logger.warn(`关闭 MCP 服务器「${id}」失败: ${errorMessage(err)}`);
      }
    }
    this.#connections.clear();
  }

  #transportFor(entry: McpServerEntry) {
    if (entry.transport === "stdio") {
      return new StdioClientTransport({
        command: entry.command ?? "",
        args: entry.args ?? [],
        ...(entry.env === undefined ? {} : { env: entry.env }),
      });
    }
    const options = {
      requestInit: entry.headers === undefined ? undefined : { headers: entry.headers },
      authProvider: undefined,
    };
    return entry.transport === "sse"
      ? new SSEClientTransport(new URL(entry.url ?? ""), {
          requestInit: options.requestInit,
        })
      : new StreamableHTTPClientTransport(new URL(entry.url ?? ""), {
          requestInit: options.requestInit,
        });
  }

  /** 连接一台服务器并拉取它的工具清单。失败记进连接表，不抛（调用方按需 probe 重试）。 */
  async connect(entry: McpServerEntry): Promise<boolean> {
    const client = new Client({ name: "atri-bot", version: "1.0.0" });
    const connection: Connection = { client, status: "error", error: null, tools: [] };
    this.#connections.set(entry.id, connection);
    try {
      await client.connect(this.#transportFor(entry));
      const { tools } = await client.listTools({}, { timeout: LIST_TIMEOUT_MS });
      connection.tools = (tools ?? []).flatMap((tool) => {
        const view = this.#remoteToolView(entry, tool);
        return view === null ? [] : [view];
      });
      connection.status = "connected";
      this.#logger.info(`MCP 服务器「${entry.id}」已连接（${connection.tools.length} 个工具）`);
      return true;
    } catch (err) {
      connection.status = "error";
      // 错误原文可能带着 URL 与请求头里的 token：只留 message，不带堆栈与配置。
      connection.error = errorMessage(err);
      this.#logger.warn(`MCP 服务器「${entry.id}」连接失败: ${connection.error}`);
      try {
        await client.close();
      } catch {
        /* 关不上就算了 */
      }
      return false;
    }
  }

  #remoteToolView(
    entry: McpServerEntry,
    tool: { name?: string; description?: string; inputSchema?: unknown },
  ): RemoteTool | null {
    const name = tool?.name;
    if (typeof name !== "string" || name === "") return null;
    // id 形如 mcp.<server>.<tool>：两边都按 id 规则归一，不合格的直接跳过 ——
    // 改名硬塞会让「模型调用了 X」与「注册表里没有 X」这对矛盾在排查时说谎。
    const id = `mcp.${entry.id}.${name}`.toLowerCase();
    if (!TOOL_ID_PATTERN.test(id)) {
      this.#logger.warn(
        `MCP 服务器「${entry.id}」的工具「${name}」拼不出合法的工具 id（${id}），已跳过`,
      );
      return null;
    }
    const schema = tool?.inputSchema;
    const inputSchema =
      schema !== null && typeof schema === "object" && !Array.isArray(schema)
        ? (schema as Record<string, unknown>)
        : { type: "object", properties: {} };
    return {
      id,
      serverId: entry.id,
      name,
      description:
        typeof tool?.description === "string" && tool.description.trim() !== ""
          ? tool.description
          : `MCP 服务器「${entry.id}」提供的工具 ${name}`,
      inputSchema,
    };
  }

  /**
   * 当前全部 MCP 工具，转成 `ToolDefinition`。`ToolRegistry` 把这个方法登记成
   * 动态来源，每次 `list()` 现读 —— 服务器连接/断开后下一轮请求立刻生效。
   */
  tools(): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const entry of this.#store.list()) {
      if (entry.enabled === false) continue;
      const connection = this.#connections.get(entry.id);
      if (connection?.status !== "connected") continue;
      const timeoutMs = validMcpTimeout(entry.timeoutMs);
      for (const remote of connection.tools) {
        out.push({
          id: remote.id,
          name: remote.name,
          description: remote.description,
          parameters: remote.inputSchema as ToolDefinition["parameters"],
          timeoutMs,
          run: async (args, options) => this.#call(entry, remote, args, options?.signal),
        });
      }
    }
    return out;
  }

  async #call(
    entry: McpServerEntry,
    remote: RemoteTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const connection = this.#connections.get(entry.id);
    if (connection?.status !== "connected") {
      throw new Error(`MCP 服务器「${entry.id}」当前未连接`);
    }
    const timeout = validMcpTimeout(entry.timeoutMs);
    // 外部信号与超时合成一个：任一触发都中止这次调用。
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeout);
    const combined = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    try {
      const result = await connection.client.callTool(
        { name: remote.name, arguments: args },
        undefined,
        { signal: combined },
      );
      if (result.isError === true) {
        // 远端明确报错：把文本带给模型（isError 的回喂是一次可纠正回合），
        // 文本由 ToolRegistry 的上限截断，这里不再截一道。
        throw new Error(this.#textOf(result.content) || "MCP 工具执行失败");
      }
      return this.#textOf(result.content);
    } finally {
      clearTimeout(timer);
    }
  }

  /** MCP 结果的 content 数组 -> 纯文本（只取 text 部分；其它类型如实说一句）。 */
  #textOf(content: unknown): string {
    if (!Array.isArray(content)) {
      return content === undefined || content === null ? "" : JSON.stringify(content);
    }
    const parts: string[] = [];
    for (const block of content) {
      if (
        block !== null &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text"
      ) {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      } else {
        parts.push("[非文本结果已省略]");
      }
    }
    return parts.join("\n");
  }

  /** 配置页的状态视图：连接状态、错误与工具清单。env/headers 原样带（鉴权闸门内）。 */
  view(id: string): McpServerView | null {
    const entry = this.#store.get(id);
    if (!entry) return null;
    return this.#viewOf(entry);
  }

  list(): McpServerView[] {
    return this.#store.list().map((entry) => this.#viewOf(entry));
  }

  #viewOf(entry: McpServerEntry): McpServerView {
    const connection = this.#connections.get(entry.id);
    return {
      id: entry.id,
      name: entry.name ?? entry.id,
      transport: entry.transport,
      ...(entry.url === undefined ? {} : { url: entry.url }),
      ...(entry.command === undefined ? {} : { command: entry.command }),
      ...(entry.args === undefined ? {} : { args: entry.args }),
      ...(entry.env === undefined ? {} : { env: entry.env }),
      ...(entry.headers === undefined ? {} : { headers: entry.headers }),
      enabled: entry.enabled !== false,
      timeoutMs: validMcpTimeout(entry.timeoutMs),
      status: connection?.status ?? (entry.enabled === false ? "disabled" : "idle"),
      error: connection?.error ?? null,
      tools: (connection?.tools ?? []).map((remote) => ({
        id: remote.id,
        name: remote.name,
        description: remote.description,
      })),
    };
  }

  /** 连接测试：重连一次并返回工具清单。配置页的「测试连接」按钮与创建后的首次连接都走这里。 */
  async probe(id: string): Promise<McpServerView | null> {
    const entry = this.#store.get(id);
    if (!entry) return null;
    // 断开旧连接再连：probe 的语义是「用当前配置试一次」，不是「沿用旧连接」。
    const previous = this.#connections.get(id);
    try {
      await previous?.client?.close();
    } catch {
      /* 旧连接关不上不影响重试 */
    }
    if (entry.enabled === false) {
      this.#connections.delete(id);
      return this.#viewOf(entry);
    }
    await this.connect(entry);
    return this.#viewOf(entry);
  }

  /** 配置变化后的收口：更新配置 -> 断开旧连接 -> 按新配置决定连不连。 */
  async applyConfig(id: string): Promise<McpServerView | null> {
    const entry = this.#store.get(id);
    const previous = this.#connections.get(id);
    try {
      await previous?.client?.close();
    } catch {
      /* 同 probe */
    }
    this.#connections.delete(id);
    if (!entry || entry.enabled === false) {
      if (entry) {
        this.#connections.set(id, {
          client: null as unknown as Client,
          status: "disabled",
          error: null,
          tools: [],
        });
      }
      return entry ? this.#viewOf(entry) : null;
    }
    await this.connect(entry);
    return this.#viewOf(entry);
  }

  async disconnect(id: string): Promise<void> {
    const previous = this.#connections.get(id);
    try {
      await previous?.client?.close();
    } catch (err) {
      this.#logger.warn(`断开 MCP 服务器「${id}」失败: ${errorMessage(err)}`);
    }
    this.#connections.delete(id);
  }
}
