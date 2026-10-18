import { test } from "node:test";
import assert from "node:assert/strict";
import type { AdapterInfo } from "@atri/shared";
import type { Logger } from "#core/logger.ts";
import { AdapterManager, type AdapterTarget } from "#adapters/manager.ts";
import { AdapterConfigStore, type AdapterEntryConfig } from "#adapters/store.ts";

/**
 * 适配器的运行期管理：配置存储、增删改启停、失败隔离。
 *
 * 平台实现（NapCat）不在这条链路里：工厂用桩替代，所以这里证的是
 * 「管理器把生命周期与持久化接对了」，不是 OneBot 报文。
 */

function silentLogger(lines: string[] = []): Logger {
  return {
    debug() {},
    info() {},
    warn: (msg: string) => lines.push(msg),
    error: (msg: string) => lines.push(msg),
  };
}

interface Files {
  value: Record<string, unknown>;
}

function fakeIo(files: Files, exists = false, read?: () => Record<string, unknown>) {
  return {
    exists: () => exists,
    ensureDir() {},
    read: read ?? (() => files.value),
    write(_file: string, value: Record<string, unknown>) {
      files.value = value;
    },
  };
}

function config(overrides: Partial<AdapterEntryConfig> = {}): AdapterEntryConfig {
  return {
    type: "napcat",
    enabled: true,
    profile: "default",
    settings: { host: "127.0.0.1", port: "6199", path: "/ws", token: "secret" },
    ...overrides,
  };
}

function setup(opts: {
  configs?: [string, Partial<AdapterEntryConfig>][];
  available?: string[];
  fail?: string[];
}) {
  const lines: string[] = [];
  const files: Files = { value: {} };
  const store = new AdapterConfigStore({
    filePath: "/tmp/atri-adapters.json",
    seed: {},
    logger: silentLogger(lines),
    io: fakeIo(files),
  });
  for (const [id, overrides] of opts.configs ?? []) store.create(id, config(overrides));

  const started: string[] = [];
  const stopped: string[] = [];
  const asked: string[] = [];
  const available = new Set(opts.available ?? ["default"]);
  const fail = new Set(opts.fail ?? []);
  const mgr = new AdapterManager({
    store,
    logger: silentLogger(lines),
    resolveProfile: (id): AdapterTarget | null => {
      asked.push(id);
      return available.has(id) ? ({ engine: {} } as unknown as AdapterTarget) : null;
    },
    createAdapter: (id) => ({
      name: id,
      start() {
        if (fail.has(id)) throw new Error("端口被占");
        started.push(id);
      },
      stop() {
        stopped.push(id);
      },
    }),
  });
  return { mgr, store, files, started, stopped, asked, lines };
}

function rowOf(rows: AdapterInfo[], id: string): AdapterInfo {
  const row = rows.find((item) => item.id === id);
  assert.ok(row, `列表里没有 ${id}`);
  return row;
}

test("startAll：只启动启用且绑定可用的，缺失与失败各自带原因", async () => {
  const h = setup({
    configs: [
      ["unbound", { profile: "" }],
      ["ghost", { profile: "nope" }],
      ["off", { enabled: false, profile: "default" }],
      ["ok", { profile: "default" }],
    ],
    available: ["default"],
  });
  await h.mgr.startAll();

  assert.deepEqual(h.started, ["ok"]);
  // 先看启动阶段问过哪些档；`list()` 的视图投影也会问，混在一起就看不见这件事了。
  assert.deepEqual(h.asked, ["nope", "default"]);
  const rows = h.mgr.list();
  assert.match(rowOf(rows, "unbound").error ?? "", /没有绑定配置档/);
  assert.match(rowOf(rows, "ghost").error ?? "", /nope/);
  assert.equal(rowOf(rows, "off").running, false);
  assert.equal(rowOf(rows, "off").enabled, false);
  assert.equal(rowOf(rows, "ok").running, true);
  // 没绑 profile / 已关掉的都不该去问解析器。
});

test("一个适配器启动失败只影响它自己", async () => {
  const h = setup({
    configs: [
      ["bad", {}],
      ["good", {}],
    ],
    fail: ["bad"],
  });
  await h.mgr.startAll();
  assert.deepEqual(h.started, ["good"]);
  const rows = h.mgr.list();
  assert.equal(rowOf(rows, "bad").running, false);
  assert.match(rowOf(rows, "bad").error ?? "", /端口被占/);
  assert.equal(rowOf(rows, "good").running, true);
});

test("新增、编辑、启停、删除都落盘并驱动生命周期", async () => {
  const h = setup({});
  const created = await h.mgr.create({
    id: "new",
    type: "napcat",
    name: "主号",
    enabled: true,
    profile: "default",
    settings: [
      { key: "host", value: "127.0.0.1" },
      { key: "port", value: "6199" },
      { key: "path", value: "/ws" },
      { key: "token", value: "abc" },
    ],
  });
  assert.equal(created.adapter.name, "主号");
  assert.equal(created.adapter.running, true);
  assert.deepEqual(created.config.settings, [
    { key: "host", value: "127.0.0.1" },
    { key: "port", value: "6199" },
    { key: "path", value: "/ws" },
    { key: "token", value: "abc" },
  ]);
  assert.deepEqual(h.started, ["new"]);
  const saved = h.files.value as { adapters?: Record<string, AdapterEntryConfig> };
  assert.equal(saved.adapters?.new?.settings.token, "abc", "settings 应写进 data/adapters.json");

  const off = await h.mgr.setEnabled("new", false);
  assert.equal(off.adapter.enabled, false);
  assert.equal(off.adapter.running, false);
  assert.deepEqual(h.stopped, ["new"]);

  const updated = await h.mgr.update("new", {
    name: "改名",
    enabled: true,
    profile: "default",
    settings: [
      { key: "host", value: "127.0.0.1" },
      { key: "port", value: "6200" },
      { key: "path", value: "/ws" },
      { key: "token", value: "abc" },
    ],
  });
  assert.equal(updated.adapter.name, "改名");
  assert.equal(updated.adapter.running, true);
  assert.equal(updated.config.settings.find((item) => item.key === "port")?.value, "6200");
  assert.deepEqual(h.started, ["new", "new"]);

  await h.mgr.remove("new");
  assert.deepEqual(h.stopped, ["new", "new"]);
  assert.equal(h.store.has("new"), false);
  assert.throws(() => h.mgr.detail("new"), /未知适配器/);
});

test("新增校验：重复 id、未知类型、缺 profile、必填与格式不对都拒绝", async () => {
  const h = setup({});
  await h.mgr.create({
    id: "dup",
    type: "napcat",
    enabled: false,
    profile: "default",
    settings: [
      { key: "host", value: "127.0.0.1" },
      { key: "port", value: "6199" },
      { key: "path", value: "/ws" },
      { key: "token", value: "secret" },
    ],
  });

  const cases: [Record<string, unknown>, RegExp][] = [
    [
      {
        id: "dup",
        type: "napcat",
        profile: "default",
        settings: [
          { key: "host", value: "127.0.0.1" },
          { key: "port", value: "6199" },
          { key: "path", value: "/ws" },
          { key: "token", value: "secret" },
        ],
      },
      /已经存在/,
    ],
    [{ id: "kind", type: "nope", profile: "default", settings: [] }, /不支持的适配器类型/],
    [
      {
        id: "noprofile",
        type: "napcat",
        profile: "",
        settings: [
          { key: "host", value: "127.0.0.1" },
          { key: "port", value: "6199" },
          { key: "path", value: "/ws" },
          { key: "token", value: "secret" },
        ],
      },
      /必须选择一份配置档/,
    ],
    [
      {
        id: "nohost",
        type: "napcat",
        profile: "default",
        settings: [
          { key: "host", value: "" },
          { key: "port", value: "6199" },
          { key: "path", value: "/ws" },
          { key: "token", value: "secret" },
        ],
      },
      /缺少必填项/,
    ],
    [
      {
        id: "badport",
        type: "napcat",
        profile: "default",
        settings: [
          { key: "host", value: "127.0.0.1" },
          { key: "port", value: "99999" },
          { key: "path", value: "/ws" },
          { key: "token", value: "secret" },
        ],
      },
      /监听端口/,
    ],
    [
      {
        id: "unknownkey",
        type: "napcat",
        profile: "default",
        settings: [
          { key: "host", value: "127.0.0.1" },
          { key: "port", value: "6199" },
          { key: "path", value: "/ws" },
          { key: "token", value: "secret" },
          { key: "nope", value: "" },
        ],
      },
      /配置项「nope」不存在/,
    ],
  ];
  for (const [input, pattern] of cases) {
    await assert.rejects(
      () =>
        h.mgr.create({
          id: String(input.id),
          type: String(input.type),
          profile: String(input.profile),
          enabled: false,
          settings: input.settings,
        }),
      pattern,
    );
  }
});

test("旧配置只在 data/adapters.json 不存在时迁移一次", () => {
  const lines: string[] = [];
  const files: Files = { value: {} };
  const store = new AdapterConfigStore({
    filePath: "/tmp/atri-adapters.json",
    seed: {
      napcat: {
        profile: "default",
        host: "127.0.0.1",
        port: "6200",
        path: "/onebot",
        token: "old",
      },
      http: { profile: "default" },
    },
    logger: silentLogger(lines),
    io: fakeIo(files),
  });
  assert.equal(store.source, "seed");
  const saved = files.value as { adapters?: Record<string, AdapterEntryConfig> };
  assert.deepEqual(saved.adapters?.napcat, {
    type: "napcat",
    enabled: true,
    profile: "default",
    settings: { host: "127.0.0.1", port: "6200", path: "/onebot", token: "old" },
  });
  assert.equal(saved.adapters?.http, undefined, "没有实现的类型不迁移");
  assert.match(lines.join("\n"), /没有对应实现/);

  // 文件已存在时完全忽略 seed，避免第二份真源。
  const existing = new AdapterConfigStore({
    filePath: "/tmp/atri-adapters.json",
    seed: { napcat: { profile: "other" } },
    logger: silentLogger(lines),
    io: fakeIo(files, true, () => ({
      adapters: {
        a: {
          type: "napcat",
          enabled: false,
          profile: "default",
          settings: { host: "127.0.0.1", port: "6200", path: "/ws", token: "a" },
        },
      },
    })),
  });
  assert.equal(existing.source, "file");
  assert.deepEqual(
    existing.list().map((item) => item.id),
    ["a"],
  );
});

test("坏文件从空表开始并记 error，不阻止服务启动", () => {
  const lines: string[] = [];
  const store = new AdapterConfigStore({
    filePath: "/tmp/broken-adapters.json",
    seed: {},
    logger: silentLogger(lines),
    io: fakeIo({ value: {} }, true, () => {
      throw new Error("不是合法 JSON");
    }),
  });
  assert.equal(store.list().length, 0);
  assert.match(lines.join("\n"), /读取适配器配置失败/);
});
