/**
 * WS 线协议的**反说谎**守卫：声明的帧类型必须真的有人发，发的帧类型必须在声明里。
 *
 * 为什么需要它：`openapi.json` 描述不了 WebSocket（README 与 architecture.md 都写了这一句），
 * 所以三道规格检查对这里的帧类型**一个字都不管**。以前 `ServerFrame` 声明了 6 种，
 * 而服务端只产生 2 种，README 又把其中 4 种写成了承诺，前端为此留了三个永不可达的分支 ——
 * 那正是「规格说谎而全部检查绿灯」的形态，本仓已有三份检查各管一层，唯独这层没人管。
 *
 * ## 锚点为什么这么挑
 * 朴素做法是抓源码里所有 `type: "..."` 字面量，那**一定会骗人**：provider 的报文里有
 * `tool_use` / `text` / `function`，工具的 JSON Schema 里有 `object`，而这类检查取的是
 * **集合**，多余取值会静默通过（假阴），漏掉的会假阳。所以只认两个**闭合**的产生点：
 *
 * - `events.emit({ type: "..." })`（在 `AgentEngine` 里）：帧字面量只在这两处内联构造，
 *   总线自己**不造帧**（它只按引用转发），所以「谁在构造帧」与「谁在分发帧」是两个集合，
 *   最后一条断言把两者分别钉住；
 * - `ws.send(JSON.stringify({ ... }))`：全仓唯一的 WS 写出形状。
 *
 * 它盖不住什么，写在下面那条断言旁边：**先把帧建在变量里再传**（
 * `const frame: ServerFrame = { type: "x" }; this.events.emit(frame)`）锚点抓不到，于是这一帧
 * 不进检查集合。两处既有站点都是字面量内联，本文件的最后一条断言要求它们各自至少命中一次
 * —— 有人改名（`emit` → `broadcast`）时取集合会变空，`⊆` 那一半就假绿通过了。
 * 彻底封死要让帧构造走 shared 里的三个小工厂再按工厂名抓；那是为一条测试给引擎热路径
 * 加一层间接，本仓的既有风格接受这种 tripwire，所以没做。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_FRAME_TYPES, SERVER_FRAME_TYPES } from "@atri/shared";

/**
 * 读源文件一律用 `new URL(相对本文件, import.meta.url)`，与
 * `openapi-response-shape.test.ts` 同一写法：不依赖 cwd，`pnpm --filter` 从哪儿跑都一样。
 * **绝不能**在这里用 `#` 别名 —— `#` 在 URL 里是片段分隔符，会静默得到错路径而不报错，
 * 而且 `imports` 别名只覆盖 `src/`，测试目录没有对应形式（AGENTS.md 的别名一节）。
 */
const source = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

interface Sink {
  /** 产生帧的文件。 */
  file: string;
  /** 报警时说清是哪个产生点。 */
  label: string;
  pattern: RegExp;
}

const SERVER_SINKS: Sink[] = [
  {
    file: "../src/core/agent/engine.ts",
    label: "AgentEngine 的出站广播",
    pattern: /events\.emit\(\{\s*type:\s*"(\w+)"/g,
  },
  {
    file: "../src/api/server.ts",
    label: "WebSocket 写出",
    pattern: /\.send\(JSON\.stringify\(\{\s*type:\s*"(\w+)"/g,
  },
];

/** 客户端方向：服务端读入站帧的地方只有这一处比较。 */
const CLIENT_SINKS: Sink[] = [
  { file: "../src/api/server.ts", label: "入站帧分派", pattern: /frame\.type === "(\w+)"/g },
];

function emittedBy(sinks: Sink[]): string[] {
  const found: string[] = [];
  for (const { file, pattern } of sinks) {
    for (const match of source(file).matchAll(pattern)) {
      const type = match[1];
      if (type) found.push(type);
    }
  }
  return found;
}

/**
 * 仓内**所有**提到 `ServerFrame` 的源文件，相对本文件的路径。
 *
 * 遍历 `src/` 而不是拿一份手工清单去比：手工清单只认识它已经知道的文件，
 * 「有人新开了第三个产生帧的文件」恰恰是它看不见的东西（那样这条断言就成了空跑）。
 */
function filesMentioning(name: string): string[] {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.name.endsWith(".ts") && readFileSync(abs, "utf8").includes(name)) {
        found.push(relOf(abs));
      }
    }
  };
  walk(root);
  return found.toSorted();
}

/** 把绝对路径折回「相对本测试文件」的写法，好让断言里的期望值不随检出位置变化。 */
function relOf(abs: string): string {
  return relative(fileURLToPath(new URL(".", import.meta.url)), abs).replaceAll("\\", "/");
}

test("服务端帧：声明的与真的被发出去的，两边集合相等", () => {
  const emitted = new Set(emittedBy(SERVER_SINKS));

  // 声明 ⊆ 实发：这条是反说谎的那一半 —— 「协议里写了一帧而没人发」就是 README 以前那句
  // 「服务端会推 stream / error / unauthorized」的成因。
  for (const declared of SERVER_FRAME_TYPES) {
    assert.ok(emitted.has(declared), `声明了 "${declared}" 帧，但两个产生点里都没有它`);
  }
  // 实发 ⊆ 声明：有人发了一帧类型上没声明的东西，客户端就无从处理。
  for (const sent of emitted) {
    assert.ok(
      (SERVER_FRAME_TYPES as readonly string[]).includes(sent),
      `发出了 "${sent}" 帧，而 ServerFrame 没声明它`,
    );
  }
});

test("客户端帧：声明的与真的被分派的，两边集合相等", () => {
  const handled = new Set(emittedBy(CLIENT_SINKS));
  for (const declared of CLIENT_FRAME_TYPES) {
    assert.ok(handled.has(declared), `声明了入站帧 "${declared}"，而服务端没有任何地方处理它`);
  }
  for (const read of handled) {
    assert.ok(
      (CLIENT_FRAME_TYPES as readonly string[]).includes(read),
      `服务端分派了 "${read}" 这一种入站帧，而 ClientFrame 没声明它`,
    );
  }
});

/**
 * 防「锚点静默归零」。
 *
 * 上面两条比的都是集合，而取集合的特性是：**锚点一个都没命中时 `⊆` 那一半照样绿**。
 * 所以这里单独要求每个产生点至少命中一次 —— 有人把 `#emit` 改名、或把帧改成
 * 先建变量再传，会先红在这里，而不是红在一个看不懂的「声明了却没发」上。
 */
test("每个锚点都真的命中了（改名或换成变量传递会先在这里红）", () => {
  for (const sink of [...SERVER_SINKS, ...CLIENT_SINKS]) {
    const hits = emittedBy([sink]);
    assert.ok(hits.length >= 1, `${sink.label} 一个帧都没抓到：锚点失效还是产生点被改走了？`);
  }
  // 今天抓到的具体取值也钉一次：它们变了就意味着上面两条比的东西跟着变了。
  assert.deepEqual([...new Set(emittedBy(SERVER_SINKS))].toSorted(), [
    "message",
    "pong",
    "unauthorized",
  ]);
});

test("产生帧的文件没有悄悄增加", () => {
  // 「提到 ServerFrame」与「构造帧字面量」现在是**两个不同的集合**，这是总线化带来的：
  // `core/agent/events.ts` 按类型转发而从不造帧（它出现的是形参与 `for...of` 的类型标注），
  // `core/agent/engine.ts` 造帧却不再写类型名（帧字面量在调用点内联）。
  // 只钉前一个集合的话，「有人新开了第三个造帧的文件」恰好看不见 —— 那两个方向分开钉。
  assert.deepEqual(filesMentioning("ServerFrame"), [
    "../src/api/server.ts",
    "../src/core/agent/events.ts",
  ]);
  assert.deepEqual(filesMatching(/\.emit\(\{\s*type:/), ["../src/core/agent/engine.ts"]);
});

/** 按**内容正则**遍历 `src/`，用途与 `filesMentioning` 相同：不靠手工清单认识新文件。 */
function filesMatching(pattern: RegExp): string[] {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.name.endsWith(".ts") && pattern.test(readFileSync(abs, "utf8"))) {
        found.push(relOf(abs));
      }
    }
  };
  walk(root);
  return found.toSorted();
}
