import { readdirSync, readFileSync, statSync } from "node:fs";
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
 *
 * ## 这一版补掉的四个静默通道（初版实测全绿）
 *
 * - `readdirSync` **不递归** → 把工具连 `index.ts` 放进 `builtins/sub/` 同时绕过两条约束。
 * - id 正则的字符集写死成 `[a-z0-9_]+` → `get-time.ts`（带 `-`）匹配不上，于是那颗
 *   **没登记**的工具安静地通过。判据不该是我抄的一份字符集：工具 id 的形状由
 *   `ToolDefinition` 与注册表决定，这里只认「引号里那段东西」，剩下的比对交给清单。
 * - 只跳 `entry.isFile()` 之外的东西、只看 `.ts` → 目录里出现 `.js` / `.md` 时静默忽略。
 * - **没有防空跑断言** → 扫到 0 个文件也打印「通过」（AGENTS.md 记着初版就栽在同类事上）。
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILTINS_REL = "apps/server/src/core/tool/builtins";
const BUILTINS_DIR = join(ROOT, BUILTINS_REL);

/** 一颗工具一个文件里声明的 id。返回 `Map<id, 文件相对路径>`，另外收集结构性违规。 */
function scanBuiltins() {
  const declared = new Map();
  const problems = [];

  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(dir, entry.name);
      // 根层没有前导段：写成 `${rel}/${entry.name}` 会得到 `builtins//get-time.ts`，
      // 而报错是给人看的，多一个斜杠就多一次「是不是路径错了」的怀疑。
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;

      // `index.ts` 在这棵树里任何一层都不该有：中间出口就是「忘了登记」的藏身处。
      if (entry.name === "index.ts") {
        problems.push(`${BUILTINS_REL}/${relPath} 存在 —— AGENTS.md 明令不要加这一层中间出口`);
        continue;
      }
      if (entry.isDirectory()) {
        // 子目录本身没被禁止（分层规则不管这个方向），但里面必须还是「一颗一文件」，
        // 所以递归进去看，而不是像初版那样整层跳过。
        walk(abs, relPath);
        continue;
      }
      if (!entry.isFile()) {
        problems.push(`${BUILTINS_REL}/${relPath} 不是普通文件`);
        continue;
      }
      if (!entry.name.endsWith(".ts")) {
        problems.push(
          `${BUILTINS_REL}/${relPath} 不是 .ts —— builtins/ 下只该有「一颗一个文件」的工具源码，` +
            "别的扩展名会被这份检查安静跳过",
        );
        continue;
      }

      const text = readFileSync(abs, "utf8");
      // 引号里就是 id，不预设字符集（见文件头第二条）。
      const ids = [...text.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
      if (ids.length === 0) {
        problems.push(
          `${BUILTINS_REL}/${relPath} 里找不到形如 id: "…" 的声明 —— ` +
            "一颗工具一个文件是约定，读不出 id 的文件既不会被登记也不会被看见",
        );
        continue;
      }
      if (ids.length > 1) {
        problems.push(
          `${BUILTINS_REL}/${relPath} 声明了 ${ids.length} 颗工具（${ids.join(" / ")}）—— ` +
            "一颗一个文件，两颗就有一个会被当成没登记的那个",
        );
      }
      // 只记第一颗：多于一条时上面的 problem 已经会红，这里不必再猜该配哪一颗。
      declared.set(ids[0], relPath);
    }
  };

  walk(BUILTINS_DIR, "");
  return { declared, problems };
}

if (!statSync(BUILTINS_DIR).isDirectory()) {
  console.error(`${BUILTINS_REL} 不是目录 —— 这道检查扫不到任何东西。`);
  process.exit(1);
}

const { declared, problems } = scanBuiltins();

// 清单**运行时**给出的那一组：真的调用一次而不是解析文本 —— 否则「import 了但没放进数组」
// 这一种漂移就看不见，而那恰恰是 AGENTS.md 担心的形态。
// `#` 别名由这些文件自己的 package.json 解析（Node 负责），所以从 scripts/ 里 import 也没问题。
const { createBuiltinTools } = await import(
  new URL("apps/server/src/core/tool/builtins.ts", `file://${ROOT}/`).href
);
const registered = new Set(createBuiltinTools({ listPlugins: () => [] }).map((tool) => tool.id));

// 防空跑：两边都空的时候下面的双向比对会一条 problem 都产生不了，于是「通过」是假的。
// 今天至少有 `current_time` 与 `list_plugins` 两颗，所以这条永远不该在正常仓库里响。
if (declared.size === 0 || registered.size === 0) {
  console.error(
    `内置工具检查扫到了空清单（文件 ${declared.size} 个、注册 ${registered.size} 颗）—— ` +
      "要么目录搬走了，要么 builtins.ts 不再导出任何东西。这道检查不能对着空集合说「通过」。",
  );
  process.exit(1);
}

for (const [id, file] of declared) {
  if (!registered.has(id))
    problems.push(`${BUILTINS_REL}/${file} 导出了工具「${id}」，但 builtins.ts 的清单里没有它`);
}
for (const id of registered) {
  if (!declared.has(id))
    problems.push(`清单里有工具「${id}」，但 builtins/ 下没有文件声明它（残留的死 import？）`);
}

if (problems.length) {
  console.error("内置工具清单与文件不同步：");
  for (const p of problems) console.error(`  ${p}`);
  console.error("\n规则见 AGENTS.md 的「新增能力时的落点」。");
  process.exit(1);
}

console.log(
  `内置工具检查通过：${registered.size} 颗工具、扫过 ${declared.size} 个文件，文件与清单一致。`,
);
