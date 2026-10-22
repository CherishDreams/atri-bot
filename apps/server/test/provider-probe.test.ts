import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "#app.ts";
import { OpenAIProvider } from "#core/provider/openai.ts";
import { probeProvider, redactProbeResult } from "#core/provider/probe.ts";
import { makeTestConfig } from "./helpers/config.ts";

type Responder = (req: IncomingMessage, res: ServerResponse) => void;

async function startUpstream(respond: Responder): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(respond);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("桩上游没有 TCP 端口");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, server };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function login(origin: string): Promise<string> {
  const res = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  assert.equal(res.status, 200);
  const first = res.headers.getSetCookie()[0];
  if (!first) throw new Error("登录响应没有 Set-Cookie");
  return first.split(";")[0] as string;
}

async function startApp(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "atri-provider-probe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = await createApp(makeTestConfig({ root, dataDir: join(root, "data") }));
  await app.start();
  t.after(() => app.stop());
  const origin = `http://127.0.0.1:${app.address().port}`;
  const cookie = await login(origin);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { origin, call };
}

test("probeProvider：API 与模型两条路径都给出 ok/延迟", async (t) => {
  const upstream = await startUpstream((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      json(res, 200, { data: [{ id: "m" }] });
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      json(res, 200, { choices: [{ message: { content: "pong" } }] });
      return;
    }
    json(res, 404, { error: { message: "not found" } });
  });
  t.after(() => new Promise<void>((resolve) => upstream.server.close(() => resolve())));

  const provider = new OpenAIProvider({
    id: "p",
    baseUrl: upstream.baseUrl,
    apiKey: "good-key",
    models: ["m"],
  });

  const api = await probeProvider(provider, "api");
  assert.equal(api.ok, true);
  assert.equal(api.kind, "api");
  assert.match(api.detail ?? "", /1 个/);
  assert.ok(api.latencyMs >= 0);

  const model = await probeProvider(provider, "model");
  assert.equal(model.ok, true);
  assert.equal(model.kind, "model");
  assert.match(model.detail ?? "", /已响应/);
});

test("probeProvider：上游失败回 ok:false，错误不抛；redact 抹掉密钥", async (t) => {
  const upstream = await startUpstream((_req, res) => {
    json(res, 401, { error: { message: "bad key sek-ret" } });
  });
  t.after(() => new Promise<void>((resolve) => upstream.server.close(() => resolve())));

  const provider = new OpenAIProvider({
    id: "p",
    baseUrl: upstream.baseUrl,
    apiKey: "sek-ret",
    models: ["m"],
  });
  const result = await probeProvider(provider, "model");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /401|鉴权|密钥|失败/);
  const redacted = redactProbeResult(result, ["sek-ret"]);
  assert.doesNotMatch(redacted.error ?? "", /sek-ret/);
});

test("POST /providers/{id}/probe：api/model 成功，坏 kind 400，未知 provider 404", async (t) => {
  const upstream = await startUpstream((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      json(res, 200, { data: [{ id: "m" }] });
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      json(res, 200, { choices: [{ message: { content: "pong" } }] });
      return;
    }
    json(res, 404, { error: { message: "not found" } });
  });
  t.after(() => new Promise<void>((resolve) => upstream.server.close(() => resolve())));
  const h = await startApp(t);

  assert.equal(
    (
      await h.call("POST", "/provider-sources", {
        id: "probe-source",
        type: "openai",
        baseUrl: upstream.baseUrl,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await h.call("POST", "/providers", {
        id: "probe-provider",
        source: "probe-source",
        model: "m",
      })
    ).status,
    201,
  );

  const api = await h.call("POST", "/providers/probe-provider/probe", { kind: "api" });
  assert.equal(api.status, 200);
  assert.equal(api.body.ok, true);
  assert.equal(api.body.kind, "api");

  const model = await h.call("POST", "/providers/probe-provider/probe", { kind: "model" });
  assert.equal(model.status, 200);
  assert.equal(model.body.ok, true);
  assert.equal(model.body.kind, "model");

  assert.equal(
    (await h.call("POST", "/providers/probe-provider/probe", { kind: "bogus" })).status,
    400,
  );
  assert.equal(
    (await h.call("POST", "/providers/no-such-provider/probe", { kind: "api" })).status,
    404,
  );
});
