import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 校验「一颗工具一个文件」与「清单登记了每一颗」这两条同时成立。
 *
 * 为什么需要它：AGENTS.md 规定 `core/tool/builtins/<id>.ts` 只导出自己那颗，
 * 由 `builtins.ts` 逐颗 import 组成唯一清单，并且**明令不要加 `builtins/index.ts`
 * 这类中间出口** —— 理由是「清单是唯一的装配点，多一处出口就会变成『改了工具文件但忘了登记』」。
 * 而注册表按注入的东西说话，忘了登记的那颗工具不会报错：它只是不存在。
 * `tool-registry.test.ts` 里那条断言比的是**已注册的**清单，所以它抓不到漏登记。
 *
 * 这里比两个方向：文件里有而清单没有（漏登记）、清单里有而文件没有（残留的死 import）。
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILTINS_DIR = join(ROOT, "apps/server/src/core/tool/builtins");

/**
 * 每个文件里声明的工具 id。约定是「一颗一个文件，文件只导出那一颗的 `ToolDefinition`」，
 * 而 `ToolDefinition.id` 是对象的**第一个**键（`currentTime.ts` / `listPlugins.ts` 都这样写，
 * 前者 2 空格缩进、后者在工厂函数的 return 里是 4 空格 —— 所以不能按缩进匹配）。
 * 取第一个 `id:` 而不是全量匹配：一旦有人在一个文件里导出两颗工具，这里就会少认一颗，
 * 而少认的那颗会以「清单里有而文件没有」报出来，不会静默通过。
 */
function declaredIds() {
  const found = new Map();
  for (const entry of readdirSync(BUILTINS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name === "index.ts") {
      console.error(
        "apps/server/src/core/tool/builtins/index.ts 存在 —— AGENTS.md 明令不要加这一层中间出口：" +
          "它会让「改了工具文件但忘了登记」变成静默失败。",
      );
      process.exit(1);
    }
    const text = readFileSync(join(BUILTINS_DIR, entry.name), "utf8");
    const m = text.match(/id:\s*"([a-z0-9_]+)"/);
    if (m?.[1]) found.set(m[1], entry.name);
  }
  return found;
}

const declared = declaredIds();

// 清单**运行时**给出的那一组：真的调用一次而不是解析文本 —— 否则「import 了但没放进数组」
// 这一种漂移就看不见，而那恰恰是 AGENTS.md 担心的形态。
// `#` 别名由这些文件自己的 package.json 解析（Node 负责），所以从 scripts/ 里 import 也没问题。
const { createBuiltinTools } = await import(
  new URL("apps/server/src/core/tool/builtins.ts", `file://${ROOT}/`).href
);
const registered = new Set(createBuiltinTools({ listPlugins: () => [] }).map((tool) => tool.id));

const problems = [];
for (const [id, file] of declared) {
  if (!registered.has(id))
    problems.push(`${file} 导出了工具「${id}」，但 builtins.ts 的清单里没有它`);
}
for (const id of registered) {
  if (!declared.has(id)) problems.push(`清单里有工具「${id}」，但 builtins/ 下没有文件声明它`);
}

if (problems.length) {
  console.error("内置工具清单与文件不同步：");
  for (const p of problems) console.error(`  ${p}`);
  console.error("\n规则见 AGENTS.md 的「新增能力时的落点」。");
  process.exit(1);
}

console.log(`内置工具检查通过：${registered.size} 颗工具，文件与清单一致。`);
