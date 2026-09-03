import { test } from "node:test";
import assert from "node:assert/strict";
import type { Logger } from "#core/logger.ts";
import { parseSse, parseSseJson } from "#core/provider/sse.ts";
import { AnthropicProvider, splitMessages } from "#core/provider/anthropic.ts";
import { OpenAIProvider } from "#core/provider/openai.ts";
import { ProviderError } from "#core/provider/errors.ts";
import { createProviders, readDefaultProviderId } from "#core/provider/factory.ts";
import { ProviderRegistry } from "#core/provider/registry.ts";
import type { ProviderImpl, ProviderOptions } from "#core/provider/types.ts";

/**
 * provider 真实发出的那份 request init：`openai.ts` / `anthropic.ts` 的 `#request()`
 * 产出的就是 `headers: Record<string, string>` + `body: string`。
 *
 * 测试的假 fetch 按这个形状读，而不是按 `RequestInit` 的联合（`HeadersInit | undefined`、
 * `BodyInit | null` 那一套）读：断言写的正是我们**确定**发出去的东西，让每个断言先去
 * 收窄一遍联合，等于把「上游收到什么」这条被测契约写成了一堆类型体操。
 */
interface SentRequest {
  method?: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

type FakeFetch = (input: string, init: SentRequest) => Promise<Response>;

/**
 * 静默 logger。这些用例断言的是返回值、抛出的错误与落盘内容，不看日志
 * （要看日志的用例走 `logSink()`）。
 */
const quietLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return quietLogger;
  },
};

/** 用内存流拼出 fetch 的 Response，避免测试依赖真实网络。 */
function sseResponse(chunks: string[], { status = 200 }: { status?: number } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonResponse(payload: unknown, { status = 200 }: { status?: number } = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * `Response.body` 的类型是 `ReadableStream | null`（没有响应体的那种响应），而这些用例
 * 构造的响应一定带体。取不到就抛，免得把 null 交给被测函数、得到一句看不出原因的报错。
 */
function streamOf(response: Response): ReadableStream<Uint8Array> {
  const body = response.body;
  if (!body) throw new Error("构造的响应没有 body");
  return body;
}

/**
 * 替换全局 fetch，跑完自动还原。
 *
 * 泛型是为了让 `const reply = await withFetch(...)` 拿回**回调的返回类型**：
 * 收成 `unknown` 的话，断言处就得写 `as ChatReply`，而这里根本没有需要断言的边界 ——
 * 类型只是被一个不必要的签名丢掉了。
 */
function withFetch<T>(handler: FakeFetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  // 边界：装进全局的是**测试替身**，它的签名比 `globalThis.fetch` 窄（只覆盖 provider
  // 实际会发出的那一支：完整 URL 字符串 + `#request()` 产出的 init）。运行期两边完全兼容，
  // 但 `globalThis.fetch` 的类型声明要求真签名，所以这里必须按 fetch 的形状赋值。
  globalThis.fetch = handler as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/**
 * 按实现类收窄 factory 造出来的那一个 provider。
 *
 * `createProviders` 交出的是 `ProviderImpl[]`（注册表认识的最小表面，见 `types.ts`），
 * 而这几条用例断言的是实现类**自己**的连接字段 `baseUrl` / `apiKey` / `timeoutMs`，
 * 它们不在那个表面上。收窄同时把「列表非空」写成前提：断言读 `providers[0].x` 本来就
 * 假定恰好构造出了一个，不满足时这里直接说清「不是这个实现类」，比让断言去读
 * `undefined.baseUrl` 好查。
 */
function onlyInstance<T extends ProviderImpl>(
  providers: ProviderImpl[],
  ctor: new (options?: ProviderOptions) => T,
): asserts providers is [T, ...T[]] {
  const first = providers[0];
  if (!(first instanceof ctor)) {
    throw new Error(`期望 provider 是 ${ctor.name} 的实例，实际是 ${first ? first.id : "空列表"}`);
  }
}

/**
 * 按下标读结果的用例（断言写的是 `frames[0].data`）在 `noUncheckedIndexedAccess`
 * 下拿到的是 `T | undefined`。这个 helper 把「至少有一帧」写成断言签名：一帧都没有
 * 就是用例失败，而原写法在这时只会得到一句 `Cannot read properties of undefined`，
 * 看不出是解析器没出帧还是 fixture 写错了。
 */
function hasFirstFrame<T>(frames: T[]): asserts frames is [T, ...T[]] {
  if (!frames[0]) throw new Error("没有解析出任何一帧");
}

// --- SSE 解析 ---------------------------------------------------------------

test("SSE：切分 data 帧并跳过注释行", async () => {
  const frames = await collect(
    parseSse(
      streamOf(
        new Response(`: connected\n\ndata: a\n\ndata: b\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    ),
  );
  assert.deepEqual(
    frames.map((f) => f.data),
    ["a", "b"],
  );
});

test("SSE：残帧留到下一块，不丢跨块边界的数据", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: par"));
      controller.enqueue(encoder.encode("tial\n\n"));
      controller.close();
    },
  });
  const frames = await collect(parseSse(body));
  assert.equal(frames.length, 1);
  hasFirstFrame(frames);
  assert.equal(frames[0].data, "partial");
});

test("SSE：结束前未闭合的帧也会被 flush", async () => {
  const frames = await collect(parseSse(streamOf(new Response(`data: tail`, { headers: {} }))));
  assert.deepEqual(
    frames.map((f) => f.data),
    ["tail"],
  );
});

test("SSE：CRLF 换行同样能切帧", async () => {
  const frames = await collect(
    parseSse(streamOf(new Response(`data: a\r\n\r\ndata: b\r\n\r\n`, { headers: {} }))),
  );
  assert.deepEqual(
    frames.map((f) => f.data),
    ["a", "b"],
  );
});

test("SSE：多行 data 用换行拼接", async () => {
  const frames = await collect(
    parseSse(streamOf(new Response(`data: line1\ndata: line2\n\n`, { headers: {} }))),
  );
  hasFirstFrame(frames);
  assert.equal(frames[0].data, "line1\nline2");
});

test("SSE：JSON 解析失败的单帧跳过，不中断整条流", async () => {
  const frames = await collect(
    parseSseJson(streamOf(new Response(`data: {bad\n\ndata: {"ok":1}\n\n`, { headers: {} }))),
  );
  assert.equal(frames.length, 1);
  hasFirstFrame(frames);
  assert.deepEqual(frames[0].payload, { ok: 1 });
});

test("SSE：data: [DONE] 原样传出而不被当成 JSON", async () => {
  const frames = await collect(
    parseSseJson(streamOf(new Response(`data: [DONE]\n\n`, { headers: {} }))),
  );
  hasFirstFrame(frames);
  assert.equal(frames[0].data, "[DONE]");
  assert.equal(frames[0].payload, null);
});

test("SSE：event 名会被解析出来", async () => {
  const frames = await collect(
    parseSseJson(
      streamOf(new Response(`event: content_block_delta\ndata: {"a":1}\n\n`, { headers: {} })),
    ),
  );
  hasFirstFrame(frames);
  assert.equal(frames[0].event, "content_block_delta");
});

// --- OpenAI provider --------------------------------------------------------

test("OpenAI：非流式取 choices[0].message.content", async () => {
  const provider = new OpenAIProvider({ id: "o", baseUrl: "https://x/v1", apiKey: "k" });
  await withFetch(
    async (url, init) => {
      assert.equal(url, "https://x/v1/chat/completions");
      assert.equal(init.headers.authorization, "Bearer k");
      const sent = JSON.parse(init.body);
      assert.equal(sent.stream, false);
      // system 留在 messages 里，这是与 Anthropic 的关键差别。
      assert.deepEqual(sent.messages[0], { role: "system", content: "s" });
      return jsonResponse({ choices: [{ message: { content: "你好" } }] });
    },
    async () => {
      const reply = await provider.chat({
        model: "m",
        messages: [{ role: "system", content: "s" }],
      });
      assert.equal(reply.content, "你好");
      assert.equal(reply.role, "assistant");
    },
  );
});

test("OpenAI：请求体不传 max_tokens（该项可选）", async () => {
  const provider = new OpenAIProvider({ id: "o", baseUrl: "https://x/v1" });
  await withFetch(
    async (_url, init) => {
      const sent = JSON.parse(init.body);
      assert.ok(!("max_tokens" in sent), "OpenAI 兼容接口不应带 max_tokens");
      return jsonResponse({ choices: [{ message: { content: "x" } }] });
    },
    () => provider.chat({ model: "m", messages: [] }),
  );
});

test("OpenAI：流式按 delta.content 累积并逐段回调", async () => {
  const provider = new OpenAIProvider({ id: "o", baseUrl: "https://x/v1" });
  const deltas: string[] = [];
  await withFetch(
    // 桩和真 fetch 一样返回 Promise（`FakeFetch` 的返回类型就是 `Promise<Response>`），
    // 所以这些不读 url/init 的桩也写成 async。
    async () =>
      sseResponse([
        `data: {"choices":[{"delta":{"content":"你"}}]}\n\n`,
        `data: {"choices":[{"delta":{"content":"好"}}]}\n\n`,
        `data: [DONE]\n\n`,
      ]),
    async () => {
      const reply = await provider.chatStream({
        model: "m",
        messages: [],
        onDelta: (d) => deltas.push(d),
      });
      assert.deepEqual(deltas, ["你", "好"]);
      assert.equal(reply.content, "你好", "返回值应与增量拼接一致");
    },
  );
});

test("OpenAI：上游 401 抛 ProviderError 且带可读提示", async () => {
  const provider = new OpenAIProvider({ id: "o", baseUrl: "https://x/v1" });
  await withFetch(
    async () => jsonResponse({ error: { message: "Invalid API key" } }, { status: 401 }),
    async () => {
      await assert.rejects(
        () => provider.chat({ model: "m", messages: [] }),
        (err) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.status, 401);
          assert.match(err.message, /密钥无效/);
          assert.match(err.message, /Invalid API key/);
          return true;
        },
      );
    },
  );
});

test("OpenAI：200 流里携带的 error 也要抛出，而不是当成空回复", async () => {
  const provider = new OpenAIProvider({ id: "o", baseUrl: "https://x/v1" });
  await withFetch(
    async () => sseResponse([`data: {"error":{"message":"overloaded"}}\n\n`]),
    async () => {
      await assert.rejects(() => provider.chatStream({ model: "m", messages: [] }), /overloaded/);
    },
  );
});

// --- Anthropic provider -----------------------------------------------------

test("Anthropic：system 提到顶层，messages 里不留 system", () => {
  const { system, body } = splitMessages([
    { role: "system", content: "S1" },
    { role: "system", content: "S2" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(system, "S1\n\nS2", "多条 system 应合并而不是互相覆盖");
  assert.deepEqual(body, [{ role: "user", content: "hi" }]);
});

test("Anthropic：相邻同角色消息被合并（上游要求严格交替）", () => {
  const { body } = splitMessages([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "assistant", content: "c" },
  ]);
  assert.equal(body.length, 2);
  if (!body[0]) throw new Error("合并后应还剩一条");
  assert.equal(body[0].content, "a\n\nb");
});

test("Anthropic：tool 角色转成 user + tool_result 块", () => {
  // 历史里带上那条 assistant(toolCalls)：真实的一轮就是「助手要求调用 → 结果回喂」，
  // 而 user 文本紧跟 tool 结果这种输入在真实循环里不会出现（会被合并成一条 user 消息，
  // 那是 mergeAdjacent 的职责，另有一条用例专门证它）。
  const { body } = splitMessages([
    { role: "user", content: "q" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "current_time", arguments: "{}" }],
    },
    { role: "tool", toolCallId: "call_1", content: "42" },
  ]);
  assert.equal(body.length, 3, "user / assistant / user(tool_result) 应当交替");
  const last = body.at(-1);
  if (!last) throw new Error("tool 消息应转成一条 user 消息");
  assert.equal(last.role, "user");
  assert.deepEqual(last.content, [{ type: "tool_result", tool_use_id: "call_1", content: "42" }]);
});

test("Anthropic：assistant 的 toolCalls 转成 tool_use 块，input 是对象", () => {
  const { body } = splitMessages([
    { role: "user", content: "几点了" },
    {
      role: "assistant",
      content: "我查一下",
      toolCalls: [{ id: "call_9", name: "current_time", arguments: '{"timezone":"UTC"}' }],
    },
  ]);
  const assistant = body[1];
  if (!assistant) throw new Error("应有那条 assistant 消息");
  assert.deepEqual(assistant.content, [
    { type: "text", text: "我查一下" },
    { type: "tool_use", id: "call_9", name: "current_time", input: { timezone: "UTC" } },
  ]);
});

test("Anthropic：并行两次调用的两条结果合并成一条 user 消息", () => {
  // 这条证的是 mergeAdjacent 的块数组分支。旧实现只在两侧都是 string 时合并，
  // 于是这里会产出两条相邻的 user 消息，被上游以「roles must alternate」拒掉 ——
  // 而那恰恰是本函数存在的理由。
  const { body } = splitMessages([
    { role: "user", content: "两个都查" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "a", name: "current_time", arguments: "{}" },
        { id: "b", name: "current_time", arguments: "{}" },
      ],
    },
    { role: "tool", toolCallId: "a", content: "1" },
    { role: "tool", toolCallId: "b", content: "2" },
  ]);
  assert.equal(body.length, 3, "两条 tool 结果必须并成一条 user 消息");
  const last = body.at(-1);
  if (!last) throw new Error("结果消息不见了");
  assert.equal(last.role, "user");
  assert.deepEqual(last.content, [
    { type: "tool_result", tool_use_id: "a", content: "1" },
    { type: "tool_result", tool_use_id: "b", content: "2" },
  ]);
});

test("Anthropic：模型给的坏参数退化成空对象，而不是让整轮失败", () => {
  const { body } = splitMessages([
    { role: "user", content: "q" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "bad", name: "current_time", arguments: "{这不是 JSON" }],
    },
  ]);
  const assistant = body[1];
  const blocks = assistant?.content;
  if (!Array.isArray(blocks)) throw new Error("assistant 的 toolCalls 应产出内容块数组");
  // 正文为空 ⇒ 没有 text 块，tool_use 就是第 0 块。
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { type: "tool_use", id: "bad", name: "current_time", input: {} });
});

// --- function calling：报文与解析 --------------------------------------------

const probeTool = {
  name: "current_time",
  description: "取此刻时间",
  parameters: { type: "object", properties: { timezone: { type: "string" } } },
};

test("OpenAI：声明工具时发 tools[]，不声明时整个键都不发", async () => {
  const provider = new OpenAIProvider({
    id: "o",
    baseUrl: "https://x/v1",
    apiKey: "k",
    models: ["m"],
  });
  const bodies: Record<string, unknown>[] = [];

  await withFetch(
    async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    },
    async () => {
      await provider.chat({ messages: [{ role: "user", content: "hi" }] });
      await provider.chat({ messages: [{ role: "user", content: "hi" }], tools: [probeTool] });
      // 空数组也必须等同于「不发」：否则默认关闭的工具会在报文里留下一个 `tools: []`。
      await provider.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    },
  );

  assert.equal(Object.hasOwn(bodies[0] ?? {}, "tools"), false, "没传 tools 时不该有这个键");
  assert.equal(Object.hasOwn(bodies[2] ?? {}, "tools"), false, "空数组也不该留下 tools 键");
  assert.deepEqual(bodies[1]?.tools, [
    {
      type: "function",
      function: {
        name: "current_time",
        description: "取此刻时间",
        parameters: probeTool.parameters,
      },
    },
  ]);
});

test("OpenAI：历史里的 toolCalls 与 tool 结果按规范形状回带", async () => {
  const provider = new OpenAIProvider({
    id: "o",
    baseUrl: "https://x/v1",
    apiKey: "k",
    models: ["m"],
  });
  let sent: { messages?: Record<string, unknown>[] } = {};

  await withFetch(
    async (_url, init) => {
      sent = JSON.parse(init.body);
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    },
    async () =>
      provider.chat({
        messages: [
          { role: "user", content: "几点了" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c1", name: "current_time", arguments: '{"timezone":"UTC"}' }],
          },
          { role: "tool", toolCallId: "c1", content: "12:00" },
        ],
      }),
  );

  const [user, assistant, tool] = sent.messages ?? [];
  assert.deepEqual(assistant, {
    role: "assistant",
    // 纯工具调用时正文是 null，不是空串：这一族的规范值就是 null。
    content: null,
    tool_calls: [
      {
        id: "c1",
        type: "function",
        function: { name: "current_time", arguments: '{"timezone":"UTC"}' },
      },
    ],
  });
  assert.deepEqual(tool, { role: "tool", tool_call_id: "c1", content: "12:00" });
  assert.deepEqual(user, { role: "user", content: "几点了" });
});

test("OpenAI：非流式的 message.tool_calls 与 finish_reason 被读出来", async () => {
  const provider = new OpenAIProvider({
    id: "o",
    baseUrl: "https://x/v1",
    apiKey: "k",
    models: ["m"],
  });
  const reply = await withFetch(
    async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c1", function: { name: "current_time", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    () => provider.chat({ messages: [{ role: "user", content: "hi" }] }),
  );
  assert.deepEqual(reply, {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "c1", name: "current_time", arguments: "{}" }],
    stopReason: "tool_calls",
  });
});

test("OpenAI：流式的 tool_calls 按 index 累加，arguments 分片不丢", async () => {
  const provider = new OpenAIProvider({
    id: "o",
    baseUrl: "https://x/v1",
    apiKey: "k",
    models: ["m"],
  });
  const frames = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"current_time","arguments":"{\\"time"}}]}}]}\n\n',
    // 第二个调用从 index 1 起，与 index 0 的分片交错到达。
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"echo","arguments":"{\\"a\\""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"zone\\":\\"UTC\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":":1}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const deltas: string[] = [];

  const reply = await withFetch(
    async () => sseResponse(frames),
    () =>
      provider.chatStream({
        messages: [{ role: "user", content: "hi" }],
        onDelta: (d) => deltas.push(d),
      }),
  );

  assert.deepEqual(reply?.toolCalls, [
    { id: "c1", name: "current_time", arguments: '{"timezone":"UTC"}' },
    { id: "c2", name: "echo", arguments: '{"a":1}' },
  ]);
  assert.equal(reply?.stopReason, "tool_calls");
  // 工具参数的碎片绝不能当成正文推给前端。
  assert.deepEqual(deltas, []);
});

test("Anthropic：tools[] 用 input_schema，空集合不发键", async () => {
  const provider = new AnthropicProvider({ id: "a", baseUrl: "https://y/v1", apiKey: "k" });
  const bodies: Record<string, unknown>[] = [];
  await withFetch(
    async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ content: [{ type: "text", text: "ok" }] });
    },
    async () => {
      await provider.chat({ messages: [{ role: "user", content: "hi" }] });
      await provider.chat({ messages: [{ role: "user", content: "hi" }], tools: [probeTool] });
    },
  );
  assert.equal(Object.hasOwn(bodies[0] ?? {}, "tools"), false);
  assert.deepEqual(bodies[1]?.tools, [
    { name: "current_time", description: "取此刻时间", input_schema: probeTool.parameters },
  ]);
});

test("Anthropic：非流式的 tool_use 块转成 toolCalls（input 序列化成串）", async () => {
  const provider = new AnthropicProvider({ id: "a", baseUrl: "https://y/v1", apiKey: "k" });
  const reply = await withFetch(
    async () =>
      jsonResponse({
        content: [
          { type: "text", text: "我查一下" },
          { type: "tool_use", id: "tu_1", name: "current_time", input: { timezone: "UTC" } },
        ],
        stop_reason: "tool_use",
      }),
    () => provider.chat({ messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(reply?.content, "我查一下");
  assert.deepEqual(reply?.toolCalls, [
    { id: "tu_1", name: "current_time", arguments: '{"timezone":"UTC"}' },
  ]);
  assert.equal(reply?.stopReason, "tool_use");
});

test("Anthropic：流式的 tool_use 由 start 给身份、input_json_delta 累加参数", async () => {
  const provider = new AnthropicProvider({ id: "a", baseUrl: "https://y/v1", apiKey: "k" });
  const frames = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"我查一下"}}\n\n',
    'event: content_block_stop\ndata: {"index":0}\n\n',
    'event: content_block_start\ndata: {"index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"current_time"}}\n\n',
    'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"time"}}\n\n',
    'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"zone\\":\\"UTC\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"index":1}\n\n',
    'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const streamed: string[] = [];

  const reply = await withFetch(
    async () => sseResponse(frames),
    () =>
      provider.chatStream({
        messages: [{ role: "user", content: "hi" }],
        onDelta: (d) => streamed.push(d),
      }),
  );

  assert.equal(reply?.content, "我查一下");
  assert.deepEqual(streamed, ["我查一下"], "只有 text_delta 能推给前端");
  assert.deepEqual(reply?.toolCalls, [
    { id: "tu_1", name: "current_time", arguments: '{"timezone":"UTC"}' },
  ]);
  assert.equal(reply?.stopReason, "tool_use");
});

test("注册表把 tools 透传给实例：两条路径各自都要证", async () => {
  const seen: { tools?: unknown }[] = [];
  const record = async (options: { tools?: unknown }) => {
    seen.push(options);
    return { content: "好" };
  };

  // 注册表是「解构后重组参数」的，漏一个键就静默失效。而它有两条出口：
  // 实例自带 chatStream，以及实例只有 chat 时的退化路径。只证其中一条，
  // 另一条被改坏时测试不会红（本仓的演练抓到过正是这种半覆盖）。
  const streaming: ProviderImpl = {
    id: "with-stream",
    models: ["m"],
    chat: (options) => record(options),
    chatStream: (options) => record(options),
  };
  const plain: ProviderImpl = {
    id: "no-stream",
    models: ["m"],
    chat: (options) => record(options),
  };

  const viaStream = new ProviderRegistry();
  viaStream.register(streaming);
  await viaStream.chatStream({
    model: "with-stream",
    messages: [{ role: "user", content: "hi" }],
    tools: [probeTool],
    onDelta: () => {},
  });

  const viaChat = new ProviderRegistry();
  viaChat.register(plain);
  await viaChat.chatStream({
    model: "no-stream",
    messages: [{ role: "user", content: "hi" }],
    tools: [probeTool],
    onDelta: () => {},
  });
  await viaChat.chat({
    model: "no-stream",
    messages: [{ role: "user", content: "hi" }],
    tools: [probeTool],
  });

  assert.deepEqual(
    seen.map((s) => s.tools),
    [[probeTool], [probeTool], [probeTool]],
    "chatStream / 退化到 chat / 直接 chat 三条路径都必须带上 tools",
  );
});

test("Anthropic：非流式从 content blocks 取文本", async () => {
  const provider = new AnthropicProvider({ id: "a", baseUrl: "https://y/v1", apiKey: "k" });
  await withFetch(
    async (url, init) => {
      assert.equal(url, "https://y/v1/messages");
      assert.equal(init.headers["x-api-key"], "k");
      assert.ok(init.headers["anthropic-version"], "必须带 anthropic-version");
      const sent = JSON.parse(init.body);
      assert.equal(sent.max_tokens, 8192, "max_tokens 在 Anthropic 是必填");
      return jsonResponse({
        content: [
          { type: "thinking", thinking: "忽略我" },
          { type: "text", text: "答案" },
        ],
      });
    },
    async () => {
      const reply = await provider.chat({ model: "m", messages: [{ role: "user", content: "q" }] });
      assert.equal(reply.content, "答案", "thinking 块不应混进正文");
    },
  );
});

test("Anthropic：没有 system 时不带该字段", async () => {
  const provider = new AnthropicProvider({ id: "a", baseUrl: "https://y/v1" });
  await withFetch(
    async (_url, init) => {
      const sent = JSON.parse(init.body);
      assert.ok(!("system" in sent), "空 system 不应下发");
      return jsonResponse({ content: [{ type: "text", text: "ok" }] });
    },
    () => provider.chat({ model: "m", messages: [{ role: "user", content: "q" }] }),
  );
});

test("Anthropic：流式按 content_block_delta 取 delta.text，遇 message_stop 结束", async () => {
  const provider = new AnthropicProvider({ id: "a", baseUrl: "https://y/v1" });
  const deltas: string[] = [];
  await withFetch(
    async () =>
      sseResponse([
        `event: message_start\ndata: {"type":"message_start"}\n\n`,
        `event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"你"}}\n\n`,
        `event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"好"}}\n\n`,
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
        // 哨兵之后的内容必须被忽略，否则重复计入。
        `event: content_block_delta\ndata: {"delta":{"text":"不该出现"}}\n\n`,
      ]),
    async () => {
      const reply = await provider.chatStream({
        model: "m",
        messages: [],
        onDelta: (d) => deltas.push(d),
      });
      assert.deepEqual(deltas, ["你", "好"]);
      assert.equal(reply.content, "你好");
    },
  );
});

test("Anthropic：429 抛 ProviderError 并提示限流", async () => {
  const provider = new AnthropicProvider({ id: "a", baseUrl: "https://y/v1" });
  await withFetch(
    async () => jsonResponse({ error: { message: "rate limited" } }, { status: 429 }),
    async () => {
      await assert.rejects(
        () => provider.chat({ model: "m", messages: [] }),
        (err) => {
          // 谓词收到的是 `unknown`（`AssertPredicate` 就是这么声明的），而这里要读的是
          // ProviderError 才有的 status / message。不是它就不成立——原写法在这条分支上
          // 同样会失败（读到 undefined 与 429 不符），只是报错更含糊。
          if (!(err instanceof ProviderError)) return false;
          assert.equal(err.status, 429);
          assert.match(err.message, /限流/);
          return true;
        },
      );
    },
  );
});

// --- 工厂与选路 -------------------------------------------------------------

test("工厂：按 type 构造对应实现，并读出默认 provider", () => {
  const { providers, errors } = createProviders(
    {
      p1: { type: "openai", baseUrl: "https://x/v1", models: ["m1"] },
      p2: { type: "anthropic", models: ["m2"] },
      default: "p2",
    },
    { logger: quietLogger },
  );
  assert.equal(errors.length, 0);
  assert.equal(providers.length, 2);
  // 断言按下标取结果，而 `noUncheckedIndexedAccess` 把下标结果标成 `T | undefined`：
  // 少一条就是用例失败，这里把它写成明确报错，而不是让断言去读 `undefined.type`。
  if (!providers[0] || !providers[1]) throw new Error("两个 provider 都该被构造出来");
  assert.equal(providers[0].type, "openai");
  assert.equal(providers[1].type, "anthropic");
  assert.equal(readDefaultProviderId({ default: "p2" }), "p2");
});

test("工厂：单个 provider 配错只进 errors，不影响其余的加载", () => {
  const { providers, errors } = createProviders(
    {
      good: { type: "openai" },
      bad: { type: "不存在的类型" },
    },
    { logger: quietLogger },
  );
  assert.equal(providers.length, 1);
  assert.equal(errors.length, 1);
  if (!errors[0]) throw new Error("配错的那条该记进 errors");
  assert.equal(errors[0].id, "bad");
});

test("工厂：apiKey 缺省时回落到环境变量", () => {
  process.env.ATRI_MY_GATEWAY_API_KEY = "from-env";
  try {
    const { providers } = createProviders(
      { "my-gateway": { type: "openai", baseUrl: "https://x/v1" } },
      { logger: quietLogger },
    );
    onlyInstance(providers, OpenAIProvider);
    assert.equal(providers[0].apiKey, "from-env");
  } finally {
    delete process.env.ATRI_MY_GATEWAY_API_KEY;
  }
});

/**
 * 两个方向都写过，才第一次真的钉住了顺序。
 *
 * 上面那条只测「文件里没配 → 落到 env」这一半，于是代码里**文件优先**的写法照样全绿，
 * 而 `.env.example` 那句「环境变量优先」一直在说谎。缺的正是「两边都有」这一格。
 */
test("工厂：文件与环境变量同时存在时，环境变量赢", () => {
  process.env.ATRI_MY_GATEWAY_API_KEY = "from-env";
  try {
    const { providers } = createProviders(
      { "my-gateway": { type: "openai", baseUrl: "https://x/v1", apiKey: "写在文件里的" } },
      { logger: quietLogger },
    );
    onlyInstance(providers, OpenAIProvider);
    assert.equal(providers[0].apiKey, "from-env");
  } finally {
    delete process.env.ATRI_MY_GATEWAY_API_KEY;
  }
});

test("工厂：环境变量是空串时不算「注入了密钥」，仍落回文件", () => {
  process.env.ATRI_MY_GATEWAY_API_KEY = "";
  try {
    const { providers } = createProviders(
      { "my-gateway": { type: "openai", baseUrl: "https://x/v1", apiKey: "写在文件里的" } },
      { logger: quietLogger },
    );
    onlyInstance(providers, OpenAIProvider);
    assert.equal(
      providers[0].apiKey,
      "写在文件里的",
      "空串通常是「变量已声明但没填」，不该把文件里那条真密钥顶掉",
    );
  } finally {
    delete process.env.ATRI_MY_GATEWAY_API_KEY;
  }
});

test("工厂：也可以靠 provider 上的 default:true 指定默认", () => {
  assert.equal(readDefaultProviderId({ a: { type: "openai" }, b: { default: true } }), "b");
});

test("选路：显式 model 命中对应 provider", async () => {
  const registry = new ProviderRegistry();
  const a = { id: "a", models: ["m1"], chat: async () => ({ content: "A" }) };
  const b = { id: "b", models: ["m2"], chat: async () => ({ content: "B" }) };
  registry.register(a);
  registry.register(b);
  const reply = await registry.chat({ model: "m2", messages: [] });
  assert.equal(reply.content, "B");
});

test("选路：model 匹配不上时退到默认 provider，而不是直接失败", async () => {
  const registry = new ProviderRegistry();
  registry.register({ id: "a", models: ["m1"], chat: async () => ({ content: "A" }) });
  registry.register({
    id: "b",
    models: ["m2"],
    chat: async ({ model }) => ({ content: `B:${model}` }),
  });
  registry.setDefault("b");
  // 上游模型名常常比本地列表更全，本地列表不该成为硬闸门。
  const reply = await registry.chat({ model: "上游新模型", messages: [] });
  assert.equal(reply.content, "B:上游新模型");
});

test("选路：未指定 model 时优先默认 provider，没有默认值则取第一个", async () => {
  const registry = new ProviderRegistry();
  // fixture 补全：`ProviderImpl` 把 `chat` 与 `models` 都列为必填（注册表与 factory
  // 直接读它们，见 types.ts），所以这里的桩要带上空 models 数组。
  registry.register({ id: "a", models: [], chat: async () => ({ content: "A" }) });
  registry.register({ id: "b", models: [], chat: async () => ({ content: "B" }) });
  assert.equal((await registry.chat({ messages: [] })).content, "A");
  registry.setDefault("b");
  assert.equal((await registry.chat({ messages: [] })).content, "B");
});

test("选路：一个 provider 都没有时才回声兜底", async () => {
  const registry = new ProviderRegistry();
  // fixture 补全：`ChatMessage` 的 `role` 必填（这条用例只读 last.content）。
  const reply = await registry.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.match(reply.content, /回声/);
});

test("选路：有 provider 时失败必须抛错，不能伪装成回复", async () => {
  const registry = new ProviderRegistry();
  registry.register({
    id: "a",
    models: [],
    chat: async () => {
      throw new Error("上游 500");
    },
  });
  await assert.rejects(() => registry.chat({ messages: [] }), /上游 500/);
});

test("选路：list() 标出默认项与实现类型", () => {
  const registry = new ProviderRegistry();
  // 这两个桩只用来验证 `list()` 的元数据视图，永远不会被调用；但 `chat` / `models`
  // 是 `ProviderImpl` 的必填字段（注册表内部直接读，见 types.ts），所以补上占位实现，
  // 而不是去放宽那个接口——放宽会让 `provider.chat(...)` 又要加守卫。
  registry.register({
    id: "a",
    name: "A",
    models: ["m"],
    type: "openai",
    chat: async () => ({ content: "不该被调用" }),
  });
  registry.register({
    id: "b",
    type: "anthropic",
    models: [],
    chat: async () => ({ content: "不该被调用" }),
  });
  registry.setDefault("b");
  const list = registry.list();
  assert.deepEqual(list[0], {
    id: "a",
    name: "A",
    models: ["m"],
    type: "openai",
    default: false,
  });
  if (!list[1]) throw new Error("两个 provider 都该在列表里");
  assert.equal(list[1].default, true);
});

test("流式：provider 未实现 chatStream 时退化为一次性回调整段", async () => {
  const registry = new ProviderRegistry();
  registry.register({ id: "a", models: [], chat: async () => ({ content: "整段" }) });
  const deltas: string[] = [];
  const reply = await registry.chatStream({ messages: [], onDelta: (d) => deltas.push(d) });
  assert.deepEqual(deltas, ["整段"]);
  assert.equal(reply.content, "整段");
});

test("注册：没有 id 的 provider 被拒绝", () => {
  // 负例：`register()` 的入参类型要求完整 `ProviderImpl`，而运行时契约是「没有 id 就抛」，
  // 这条用例要验的正是不满足那个签名的输入。把绑定标成「入参更宽」的结构视图即可
  // （方法声明是双变的，真 ProviderRegistry 能满足），运行时用的仍是同一个注册表。
  const registry: { register(provider: unknown): unknown } = new ProviderRegistry();
  assert.throws(() => registry.register({}), /必须带有 id/);
});

// --- 两层配置：provider source + provider 实例 ------------------------------

/** 收集日志，用来断言「有意跳过」与「真的失败」走的是不同通道。 */
function logSink(): { lines: [level: string, msg: string][]; logger: Logger } {
  const lines: [level: string, msg: string][] = [];
  return {
    lines,
    // `debug` / `child` 在这些用例里不会被调用（factory 只走 info），补上只为满足
    // `Logger` 的完整形状——少一个字段就是「不合法的 logger」，那是另一个错误。
    logger: {
      info: (m) => lines.push(["info", m]),
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => quietLogger,
    },
  };
}

test("两层：实例从 source 继承连接配置，自己只带 model", () => {
  const { providers, errors } = createProviders(
    { "deepseek-chat": { source: "deepseek", model: "deepseek-chat" } },
    {
      sources: {
        deepseek: {
          type: "openai",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "sk-src",
          timeoutMs: 30_000,
        },
      },
      logger: quietLogger,
    },
  );

  assert.equal(errors.length, 0);
  assert.equal(providers.length, 1);
  onlyInstance(providers, OpenAIProvider);
  assert.equal(providers[0].baseUrl, "https://api.deepseek.com/v1");
  assert.equal(providers[0].apiKey, "sk-src");
  assert.equal(providers[0].timeoutMs, 30_000);
  // 一个 provider 就是一个模型实例，所以 model 要变成单元素 models 数组，
  // 注册表原来的按模型名选路才能继续工作。
  assert.deepEqual(providers[0].models, ["deepseek-chat"]);
});

test("两层：实例上的字段覆盖 source 上的同名字段", () => {
  const { providers } = createProviders(
    {
      "my-claude": {
        source: "claude",
        model: "claude-sonnet-4-5",
        baseUrl: "https://gateway.example.com/v1",
        name: "生产用 Claude",
        timeoutMs: 5_000,
      },
    },
    {
      sources: {
        claude: { type: "anthropic", baseUrl: "https://api.anthropic.com/v1", timeoutMs: 120_000 },
      },
      logger: quietLogger,
    },
  );

  onlyInstance(providers, AnthropicProvider);
  assert.equal(providers[0].baseUrl, "https://gateway.example.com/v1");
  assert.equal(providers[0].timeoutMs, 5_000);
  assert.equal(providers[0].name, "生产用 Claude");
  assert.equal(providers[0].type, "anthropic");
});

test("两层：apiKey 缺省时按 source 的 id 回落环境变量", () => {
  // 凭证属于 source（多个实例共享一份），所以变量名要跟 source 走，
  // 否则同一个源下的每个模型都得各配一遍密钥。
  process.env.ATRI_MY_GATEWAY_API_KEY = "from-env";
  try {
    const { providers } = createProviders(
      { "a-m": { source: "my-gateway", model: "m" } },
      {
        sources: { "my-gateway": { type: "openai", baseUrl: "https://x/v1" } },
        logger: quietLogger,
      },
    );
    onlyInstance(providers, OpenAIProvider);
    assert.equal(providers[0].apiKey, "from-env");
  } finally {
    delete process.env.ATRI_MY_GATEWAY_API_KEY;
  }
});

test("两层：源配了 apiKey 而环境变量也在时，环境变量赢", () => {
  // 两层结构下凭证属于源，所以「谁赢」这件事只需要在源这一层判一次。
  // 这一格以前同样没人测：只测「缺省回落」的话，文件优先的实现照样全绿。
  process.env.ATRI_MY_GATEWAY_API_KEY = "from-env";
  try {
    const { providers } = createProviders(
      { "a-m": { source: "my-gateway", model: "m" } },
      {
        sources: {
          "my-gateway": { type: "openai", baseUrl: "https://x/v1", apiKey: "源里写的" },
        },
        logger: quietLogger,
      },
    );
    onlyInstance(providers, OpenAIProvider);
    assert.equal(providers[0].apiKey, "from-env");
  } finally {
    delete process.env.ATRI_MY_GATEWAY_API_KEY;
  }
});

test("两层：引用了不存在的 source 时进 errors，不阻断别的加载", () => {
  const { providers, errors } = createProviders(
    {
      ghost: { source: "不存在", model: "m" },
      inline: { type: "openai", models: ["m2"] },
    },
    { sources: {}, logger: quietLogger },
  );

  assert.equal(providers.length, 1);
  assert.equal(errors.length, 1);
  if (!errors[0]) throw new Error("引用不到源的那条该记进 errors");
  assert.equal(errors[0].id, "ghost");
  assert.match(errors[0].message, /未找到 id 为「不存在」的 provider source/);
});

test("两层：enabled:false 被跳过，且不算失败", () => {
  // 有意关掉不是故障：报成 error 会让人以为配置坏了，于是去改本来对的东西。
  const sink = logSink();
  const { providers, errors } = createProviders(
    {
      off: { source: "s", model: "m", enabled: false },
      on: { source: "s", model: "m2" },
    },
    { sources: { s: { type: "openai" } }, logger: sink.logger },
  );

  assert.equal(providers.length, 1);
  if (!providers[0]) throw new Error("没被禁用的那条该加载出来");
  assert.equal(providers[0].models[0], "m2");
  assert.equal(errors.length, 0);
  assert.ok(sink.lines.some(([, m]) => /已禁用/.test(m)));
});

test("两层：内联老写法（自己带 type/baseUrl）继续可用，不需要数据迁移", () => {
  const { providers, errors } = createProviders(
    { legacy: { type: "openai", baseUrl: "https://old/v1", apiKey: "k", models: ["m"] } },
    { sources: {}, logger: quietLogger },
  );

  assert.equal(errors.length, 0);
  onlyInstance(providers, OpenAIProvider);
  assert.equal(providers[0].baseUrl, "https://old/v1");
  assert.deepEqual(providers[0].models, ["m"]);
});

test("注册表：clear() 清空全部 provider 与默认项", () => {
  const registry = new ProviderRegistry();
  registry.register({ id: "a", models: ["m"], chat: async () => ({ content: "A" }) });
  registry.setDefault("a");
  assert.equal(registry.size, 1);

  registry.clear();

  assert.equal(registry.size, 0);
  assert.equal(registry.defaultId, null);
});
