import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * `packages/shared` 的类型与 `apps/server/openapi.json` 之间**必须有机械绑定**。
 *
 * 为什么这道检查存在：那两个地方描述的是同一批响应体，但真源不同 ——
 * dashboard 的类型由规格生成，server 的类型来自 `shared`。`types.ts` 里以前对此的自述是
 * 「改一处必须改两处，而没有任何检查在绑它们」，那等于把契约交给记忆力。
 * `openapi-response-shape.test.ts` 驱动真端点逐字段比对，但它只管**单向**
 *（「规格写了 required 而实际没给」会红，「实际永远都给而规格没写 required」不会），
 * 于是漂的方向恰好是「前端多出一层根本不可能的空判断」——那种代码没人会去删，
 * 因为它读起来像是防御性编程。
 *
 * 这里比的是**声明与声明**，不发消息也不起服务：只认结构性事实
 *（`shared` 的成员有没有 `?`、规格的 `required` 里有没有这个键），
 * 与 `scripts/check-*.mjs` 是同一类判据。
 *
 * 覆盖范围刻意由 `COMPARABLE` 这张表列出而不是自动全部比对：`shared` 里还有只出现在
 * 请求侧或纯内部的形状，把它们塞进比对只会得到一堆「规格里没有这个 schema」的噪音。
 * 加一行进来之前先确认那一份形状**两端都在描述同一个响应体**。
 */

const TYPES_PATH = fileURLToPath(new URL("../../../packages/shared/src/types.ts", import.meta.url));
const SPEC_PATH = fileURLToPath(new URL("../openapi.json", import.meta.url));

/** 名字在两边都有、且描述同一个 HTTP 形状的那些 interface / 联合类型。 */
const COMPARABLE = [
  "AdapterAccessControl",
  "AdapterInfo",
  "CommandInfo",
  "CronJobInfo",
  "CronLastStatus",
  "LogEntry",
  "LogLevel",
  "MemoryConfig",
  "Message",
  "PersonaInfo",
  "PluginInfo",
  "PluginStatus",
  "ProfileConfig",
  "ProfileRecord",
  "ProfileStatus",
  "ProviderInfo",
  "Session",
  "ToolInfo",
] as const;

interface SpecSchema {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, unknown>;
  enum?: unknown[];
}

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as {
  components: { schemas: Record<string, SpecSchema> };
};
const typesSource = readFileSync(TYPES_PATH, "utf8");

/**
 * `export interface X { … }` 的成员表。
 *
 * 只认「两个空格缩进 + `标识符` + 可选的 `?` + `:`」这一种行 —— 本文件的写法由
 * `.oxfmtrc.json` 固定（2 空格），而嵌套的对象类型成员缩进更深，不会被当成顶层成员。
 * 这是文本比对而不是 AST：本仓不引依赖（AGENTS.md「依赖极简」），而这里要的判据
 * 恰好只有「有没有那个 `?`」，不值得为此装一个 TS 解析器。
 */
function membersOf(name: string): Map<string, boolean> {
  const start = typesSource.indexOf(`export interface ${name} {`);
  assert.notEqual(start, -1, `packages/shared/src/types.ts 里没有 export interface ${name}`);
  const end = typesSource.indexOf("\n}", start);
  assert.notEqual(end, -1, `${name} 的 interface 体没有正常收尾`);
  const body = typesSource.slice(start, end);
  const found = new Map<string, boolean>();
  for (const line of body.split("\n").slice(1)) {
    const m = line.match(/^ {2}(?:readonly )?([A-Za-z0-9_]+)(\??):/);
    if (m?.[1]) found.set(m[1], m[2] === "?");
  }
  assert.ok(found.size > 0, `${name} 没解析出任何成员（判据该更新了，而不是让它空跑）`);
  return found;
}

/** `export type X = "a" | "b";` 的字面量取值集合。 */
function unionOf(name: string): string[] {
  const m = typesSource.match(new RegExp(`export type ${name} = ([^;]+);`));
  assert.ok(m, `types.ts 里找不到 export type ${name} = …`);
  const values = (m[1] ?? "").split("|").map((s) => s.trim().replace(/^"|"$/g, ""));
  assert.ok(values.length > 0, `${name} 没解析出取值`);
  return values;
}

/**
 * 规格比 `shared` 那个 interface **多**声明的键，按 schema 逐个列出来。
 *
 * 这不是豁免口子，而是一次必须写下来的分歧：`GET /plugins` 的一项比 `ctx.plugins()` 的
 * 同伴视图多一个 `error` —— 那句是「上一次加载失败的可读原因」，来自第三方代码，可能带着
 * 绝对路径，所以只给操作者，绝不进插件能拿到的那一份（AGENTS.md 的插件白名单那条规矩）。
 * 服务端里对应的类型是 `PluginView = PluginInfo & { error: string | null }`
 *（`plugins/manager.ts`），而 `shared` 只描述两者共同的那一半。
 *
 * 更彻底的形状是在规格里把它拆成两份 schema（`PluginInfo` 与「`PluginInfo` + `error`」），
 * 但那会同时改生成 SDK 的类型与 dashboard 里读 `p.error` 的地方，属于另一次改动。
 * 加一行进来之前先回答：这个键是不是「某一侧的消费者根本不该看到」？是的话它不该在这里
 * 被加宽，而应该在规格里另立一个 schema。
 */
const SPEC_ADDS: Record<string, string[]> = {
  PluginInfo: ["error"],
};

for (const name of COMPARABLE) {
  test(`shared 与规格对 ${name} 的声明一致（required / 可选 / 枚举）`, () => {
    const node = spec.components.schemas[name];
    assert.ok(node, `openapi.json 里没有 components.schemas.${name}`);

    // 联合类型 ↔ 规格 enum：这一支管的是「协议键的取值」。
    if (node.enum) {
      const fromTs = unionOf(name).toSorted();
      const fromSpec = (node.enum as unknown[]).map(String).toSorted();
      assert.deepEqual(
        fromTs,
        fromSpec,
        `${name} 的取值在两端不一样：shared ${JSON.stringify(fromTs)} vs 规格 ${JSON.stringify(fromSpec)}`,
      );
      return;
    }

    const members = membersOf(name);
    const required = new Set(node.required ?? []);
    const props = Object.keys(node.properties ?? {});

    for (const [key, optional] of members) {
      assert.ok(
        props.includes(key),
        `${name}.${key} 在 shared 里有，但规格的 properties 里没有 —— 生成 SDK 的类型不会有它`,
      );
      if (!optional) {
        assert.ok(
          required.has(key),
          `${name}.${key} 在 shared 里是必填，规格却没写进 required —— dashboard 会多一层根本不可能的空判断`,
        );
      } else {
        assert.equal(
          required.has(key),
          false,
          `${name}.${key} 在 shared 里可空，规格却把它列进 required —— 前端会在它缺失时读到 undefined 而类型说它有`,
        );
      }
    }

    // 反方向：规格声明的成员必须都在 shared 里（多出来的键同样是说谎，只是方向相反）。
    // 唯一的例外要在 `SPEC_ADDS` 里点名 —— 那是「同一个 schema 服务两个消费者」的分歧，
    // 必须写下来，而不是让比对放过一整类。
    const extra = SPEC_ADDS[name] ?? [];
    for (const key of props) {
      if (extra.includes(key)) continue;
      assert.ok(
        members.has(key),
        `规格给 ${name} 声明了 ${key}，shared 的那个 interface 里没有它（真要有意多一个键就写进 SPEC_ADDS 并说明理由）`,
      );
    }
  });
}
