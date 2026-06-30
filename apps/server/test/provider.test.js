import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSse, parseSseJson } from "../src/core/provider/sse.js";
import { AnthropicProvider, splitMessages } from "../src/core/provider/anthropic.js";
import { OpenAIProvider } from "../src/core/provider/openai.js";
import { ProviderError } from "../src/core/provider/errors.js";
import { createProviders, readDefaultProviderId } from "../src/core/provider/factory.js";
import { ProviderRegistry } from "../src/core/provider/registry.js";

/** 用内存流拼出 fetch 的 Response，避免测试依赖真实网络。 */
function sseResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
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

function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 替换全局 fetch，跑完自动还原。 */
function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

// --- SSE 解析 ---------------------------------------------------------------

test("SSE：切分 data 帧并跳过注释行", async () => {
  const frames = await collect(
    parseSse(
      new Response(`: connected\n\ndata: a\n\ndata: b\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }).body,
    ),
  );
  assert.deepEqual(
    frames.map((f) => f.data),
    ["a", "b"],
  );
});

test("SSE：残帧留到下一块，不丢跨块边界的数据", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: par"));
      controller.enqueue(encoder.encode("tial\n\n"));
      controller.close();
    },
  });
  const frames = await collect(parseSse(body));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data, "partial");
});

test("SSE：结束前未闭合的帧也会被 flush", async () => {
  const frames = await collect(parseSse(new Response(`data: tail`, { headers: {} }).body));
  assert.deepEqual(
    frames.map((f) => f.data),
    ["tail"],
  );
});

test("SSE：CRLF 换行同样能切帧", async () => {
  const frames = await collect(
    parseSse(new Response(`data: a\r\n\r\ndata: b\r\n\r\n`, { headers: {} }).body),
  );
  assert.deepEqual(
    frames.map((f) => f.data),
    ["a", "b"],
  );
});

test("SSE：多行 data 用换行拼接", async () => {
  const frames = await collect(
    parseSse(new Response(`data: line1\ndata: line2\n\n`, { headers: {} }).body),
  );
  assert.equal(frames[0].data, "line1\nline2");
});

test("SSE：JSON 解析失败的单帧跳过，不中断整条流", async () => {
  const frames = await collect(
    parseSseJson(new Response(`data: {bad\n\ndata: {"ok":1}\n\n`, { headers: {} }).body),
  );
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].payload, { ok: 1 });
});

test("SSE：data: [DONE] 原样传出而不被当成 JSON", async () => {
  const frames = await collect(
    parseSseJson(new Response(`data: [DONE]\n\n`, { headers: {} }).body),
  );
  assert.equal(frames[0].data, "[DONE]");
  assert.equal(frames[0].payload, null);
});

test("SSE：event 名会被解析出来", async () => {
  const frames = await collect(
    parseSseJson(
      new Response(`event: content_block_delta\ndata: {"a":1}\n\n`, { headers: {} }).body,
    ),
  );
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
  const deltas = [];
  await withFetch(
    () =>
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
    () => jsonResponse({ error: { message: "Invalid API key" } }, { status: 401 }),
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
    () => sseResponse([`data: {"error":{"message":"overloaded"}}\n\n`]),
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
  assert.equal(body[0].content, "a\n\nb");
});

test("Anthropic：tool 角色转成 user + tool_result 块", () => {
  const { body } = splitMessages([
    { role: "user", content: "q" },
    { role: "tool", toolCallId: "call_1", content: "42" },
  ]);
  const last = body.at(-1);
  assert.equal(last.role, "user");
  assert.deepEqual(last.content, [{ type: "tool_result", tool_use_id: "call_1", content: "42" }]);
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
  const deltas = [];
  await withFetch(
    () =>
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
    () => jsonResponse({ error: { message: "rate limited" } }, { status: 429 }),
    async () => {
      await assert.rejects(
        () => provider.chat({ model: "m", messages: [] }),
        (err) => {
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
    { logger: { warn() {}, error() {} } },
  );
  assert.equal(errors.length, 0);
  assert.equal(providers.length, 2);
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
    { logger: { warn() {}, error() {} } },
  );
  assert.equal(providers.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, "bad");
});

test("工厂：apiKey 缺省时回落到环境变量", () => {
  process.env.ATRI_MY_GATEWAY_API_KEY = "from-env";
  try {
    const { providers } = createProviders(
      { "my-gateway": { type: "openai", baseUrl: "https://x/v1" } },
      { logger: { warn() {}, error() {} } },
    );
    assert.equal(providers[0].apiKey, "from-env");
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
  registry.register({ id: "a", chat: async () => ({ content: "A" }) });
  registry.register({ id: "b", chat: async () => ({ content: "B" }) });
  assert.equal((await registry.chat({ messages: [] })).content, "A");
  registry.setDefault("b");
  assert.equal((await registry.chat({ messages: [] })).content, "B");
});

test("选路：一个 provider 都没有时才回声兜底", async () => {
  const registry = new ProviderRegistry();
  const reply = await registry.chat({ model: "m", messages: [{ content: "hi" }] });
  assert.match(reply.content, /回声/);
});

test("选路：有 provider 时失败必须抛错，不能伪装成回复", async () => {
  const registry = new ProviderRegistry();
  registry.register({
    id: "a",
    chat: async () => {
      throw new Error("上游 500");
    },
  });
  await assert.rejects(() => registry.chat({ messages: [] }), /上游 500/);
});

test("选路：list() 标出默认项与实现类型", () => {
  const registry = new ProviderRegistry();
  registry.register({ id: "a", name: "A", models: ["m"], type: "openai" });
  registry.register({ id: "b", type: "anthropic" });
  registry.setDefault("b");
  const list = registry.list();
  assert.deepEqual(list[0], {
    id: "a",
    name: "A",
    models: ["m"],
    type: "openai",
    default: false,
  });
  assert.equal(list[1].default, true);
});

test("流式：provider 未实现 chatStream 时退化为一次性回调整段", async () => {
  const registry = new ProviderRegistry();
  registry.register({ id: "a", chat: async () => ({ content: "整段" }) });
  const deltas = [];
  const reply = await registry.chatStream({ messages: [], onDelta: (d) => deltas.push(d) });
  assert.deepEqual(deltas, ["整段"]);
  assert.equal(reply.content, "整段");
});

test("注册：没有 id 的 provider 被拒绝", () => {
  const registry = new ProviderRegistry();
  assert.throws(() => registry.register({}), /必须带有 id/);
});
