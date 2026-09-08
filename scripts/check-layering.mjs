import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 分层检查：AGENTS.md 里那条「硬约束」此前**没有任何东西在守**。
 *
 * 为什么需要一道脚本而不是靠 review：oxlint 不解析模块路径，`tsc` 不看目录，
 * 而这条约束的价值恰恰在「换传输层不碰业务逻辑」这种十年才用一次、
 * 破坏了也不会立刻报错的性质上。本仓已经有过一次「注释说没有环、代码里双向」的偏差
 *（见 docs/architecture.md 的依赖方向一节），靠人记住是记不住的。
 *
 * 规则按**文件所属的顶层目录**判。`config/` 与 `core/` 之间允许双向
 *（两条边落在不同文件上，不是循环依赖），所以这里禁的是一张「方向表」，
 * 不是「出现双向就红」—— 后者会一检查就红，而红的原因不是有环，那种检查只会教人忽略它。
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "apps/server/src");

/** 每个层允许 import 哪些层。组合根（`app.ts` / `index.ts`）不受限 —— 它就是用来连线的地方。 */
const ALLOWED = {
  core: new Set(["core", "config"]),
  config: new Set(["core", "config"]),
  api: new Set(["core", "config", "api", "plugins", "adapters"]),
  adapters: new Set(["core", "config", "adapters"]),
  // 插件层只依赖注入给它的 ctx，但可以读 core 的叶子（errors / logger 的类型与函数）。
  plugins: new Set(["core", "config", "plugins"]),
};

const LAYERS = new Set(Object.keys(ALLOWED));

function toPosix(p) {
  return sep === "/" ? p : p.split(sep).join("/");
}

/** 相对仓库根的路径。**用 `relative()` 而不是截字符串**：见下面 `filesScanned` 那段。 */
function relOf(abs) {
  return toPosix(relative(ROOT, abs));
}

/** 相对 `src/` 的路径 —— 分层是按这个判的。 */
function srcRel(abs) {
  return toPosix(relative(SRC, abs));
}

function layerOf(rel) {
  const top = rel.split("/")[0];
  return LAYERS.has(top) ? top : null; // src 根下的文件（app.ts / index.ts）是组合根
}

/** 收集 import 说明符。`import type` 也算：类型耦合同样会把方向定死。 */
function specifiersOf(text) {
  const found = [];
  const patterns = [
    /(?:^|\n)\s*import\s+[^"']*?from\s*"([^"]+)"/g,
    /(?:^|\n)\s*export\s+[^"']*?from\s*"([^"]+)"/g,
    /\bimport\("([^"]+)"\)/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      if (m[1]) found.push(m[1]);
    }
  }
  return found;
}

/** 把说明符归一成「相对 src 的路径」；包名（node:*、ws、@atri/shared）返回 null 不归本检查管。 */
function resolveSpecifier(spec) {
  if (spec.startsWith("#")) return spec.slice(1);
  if (spec.startsWith(".")) return spec; // 相对形式单独判（见规则 3），这里不参与分层比对
  return null;
}

function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(abs));
    else if (entry.name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

const problems = [];
const files = tsFiles(SRC);
const layersSeen = new Set();
let edgesChecked = 0;

for (const abs of files) {
  const from = srcRel(abs);
  const fromLayer = layerOf(from);
  if (fromLayer) layersSeen.add(fromLayer);
  const text = readFileSync(abs, "utf8");

  // 1) 方向表（只在两个端点都属于已知层时比对；组合根不受限）
  if (fromLayer) {
    for (const spec of specifiersOf(text)) {
      const target = resolveSpecifier(spec);
      if (!target) continue;
      const toLayer = layerOf(target);
      if (!toLayer || toLayer === fromLayer) continue;
      edgesChecked += 1;
      if (!ALLOWED[fromLayer].has(toLayer)) {
        problems.push(`${relOf(abs)}: ${fromLayer}/ 不得 import ${toLayer}/（${spec}）`);
      }
    }
  }

  // 2) 服务端不允许向上跳的相对说明符：跨目录改用 `#` 别名（AGENTS.md 的口径是「向上跳才用 #」）
  // 3) 本地说明符必须带 `.ts`：服务端直接跑 .ts 源码，擦除不改写说明符，写 `.js` 就解析不到文件
  for (const spec of specifiersOf(text)) {
    if (!spec.startsWith(".")) continue;
    if (spec.startsWith("../")) {
      problems.push(`${relOf(abs)}: 跨目录 import 请用 # 别名（${spec}）`);
    } else if (/\.(js|mjs)$/.test(spec)) {
      problems.push(`${relOf(abs)}: 本地说明符要写 .ts，服务端没有编译步骤（${spec}）`);
    }
  }

  // 4) `#` 不能出现在 URL 解析里：那里它是片段分隔符，会静默得到错路径而不报错
  for (const m of text.matchAll(/new URL\(\s*"([^"]*)"/g)) {
    if (m[1]?.includes("#")) {
      problems.push(`${relOf(abs)}: new URL("${m[1]}") 里带了 # —— 会被当片段分隔符，静默错路径`);
    }
  }
}

/**
 * 防空跑。这道检查「通过」的全部依据是它遍历到了东西，而遍历的输入来自路径拼接 ——
 * 本脚本初版就是把 `ROOT` 的尾斜杠算进切片，于是 `layerOf` 永远返回 null，
 * 方向表一条都没比对却打印了「通过」。所以这里显式要求层与边都被看见过。
 */
const expectedLayers = ["api", "core", "config", "adapters", "plugins"];
for (const layer of expectedLayers) {
  if (!layersSeen.has(layer)) {
    console.error(
      `分层检查自身有问题：src/ 下没看见 ${layer}/ 层的文件（路径拼接错了？扫到 ${files.length} 个文件）`,
    );
    process.exit(1);
  }
}
if (edgesChecked < 10) {
  console.error(`分层检查自身有问题：只比对了 ${edgesChecked} 条跨层边，不可能这么少`);
  process.exit(1);
}
if (files.length < 20) {
  console.error(`分层检查自身有问题：src/ 下只找到 ${files.length} 个 .ts 文件`);
  process.exit(1);
}

// 5) `packages/shared` 不得配 `imports`：它的 exports/files 都指 dist/，
//    再配一份指向 src/ 的映射会让 dashboard 与 shared 内部解析出**两份副本**
const sharedPkg = JSON.parse(readFileSync(join(ROOT, "packages/shared/package.json"), "utf8"));
if (sharedPkg.imports) {
  problems.push("packages/shared/package.json 出现了 imports —— 常量会有两份运行时副本");
}

if (problems.length) {
  console.error("分层检查未通过：");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\n规则与理由见 AGENTS.md 的「分层（硬约束）」与 docs/architecture.md 的依赖方向一节。",
  );
  process.exit(1);
}

console.log(
  `分层检查通过：${files.length} 个源文件、${edgesChecked} 条跨层边，方向与说明符写法都合规。`,
);
