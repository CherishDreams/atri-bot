import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
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
 *
 * ## 这一版补掉的洞（初版对每一种都能说「通过」）
 *
 * - **未知顶层目录默认放行**：`layerOf` 对不在表里的目录返回 `null`，方向比对整块跳过。
 *   实测新建 `src/mcp/index.ts` 同时 import `#api/` 与 `#plugins/` 是绿的 ——
 *   于是「硬约束」的实际守法变成「没人加过新目录」，而不是「脚本会拦」。现在反过来：
 *   `src/` 下的文件必须属于某个已登记的层，否则就是违规。
 * - **`#app.ts` 这类「import 组合根」看不见**：`app.ts` 认识所有层，
 *   `core/` 只要 import 它一次，「core 不依赖上层」就在**传递依赖**上被击穿，
 *   而逐条 import 看起来都合规。现在显式禁止非组合根 import `app.ts` / `index.ts`。
 * - **相对说明符不参与分层比对**：`resolveSpecifier` 见到 `.` 开头就原样返回，
 *   于是 `./../../plugins/manager.ts`（不以 `../` 开头，规则 2 也漏）两边都不管。
 *   现在按文件所在目录**归一化**之后再判层，`..` 一律要求改用 `#` 别名。
 * - **只认双引号**：单引号写法整个匹配不上。两种都收。
 * - **变量式动态 import 不可见**：`import(url)` 的说明符是变量，静态读不出来。
 *   本仓唯一合法的这一用法是插件装载（`plugins/manager.ts` 读磁盘上的 `index.js`），
 *   所以把它写成白名单：其它层出现就是新洞，而不是「检查没覆盖」。
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "apps/server/src");

/** 每个层允许 import 哪些层。组合根（下面的 `COMPOSITION_ROOT`）不受限 —— 它就是用来连线的地方。 */
const ALLOWED = {
  core: new Set(["core", "config"]),
  // `config` 允许指向 `core`，但**不是因为有一张双向图要供着**：这一侧现在只有
  // `config/file.ts → core/errors.ts`（`errorMessage`）与 `config/profiles.ts → core/errors.ts`
  //（`ApiError`）两条边，都是纯工具函数。历史上第三条 `config/config.ts → core/tool/store.ts`
  //（只为一个 `DEFAULT_MAX_TOOL_STEPS`）已经把运行期配置搬进配置档后消失了 —— 别把它当成
  // 「已经修完」：双向仍然存在，判据仍然是「同一对目录只允许一个方向 ≠ 不允许双向」。
  config: new Set(["core", "config"]),
  api: new Set(["core", "config", "api", "plugins", "adapters"]),
  adapters: new Set(["core", "config", "adapters"]),
  // 插件层只依赖注入给它的 ctx，但可以读 core 的叶子（errors / logger 的类型与函数）。
  // 对 `config` 只允许**类型**（见下面 `TYPE_ONLY_ALLOWED_EDGES`）：实现级的
  // `plugins/ → config/` 那条（`ensurePrivateDir`）已经改成组合根注入。
  plugins: new Set(["core", "config", "plugins"]),
};

/**
 * 「这两个层之间只许走类型 import」。类型耦合不会在运行时把实现递过去，
 * 而 `import type` 在本仓是编译期强制的（`verbatimModuleSyntax`），所以它可被静态认出。
 * 加一条进来之前先想清楚：这条边的另一端是不是真的只是形状 —— `plugins/` 读配置值的
 * 正确形状是**注入**（`persistEnabled`、`ensurePrivateDir` 都是这么办的）。
 */
const TYPE_ONLY_ALLOWED_EDGES = new Set(["plugins->config"]);

/** src 根下的这两个文件是组合根：不受方向表限制，也不许被别人 import（见规则 1b）。 */
const COMPOSITION_ROOT = new Set(["app.ts", "index.ts"]);

/** 只有 plugins/ 里允许「说明符来自变量」的动态 import（磁盘上用户手写的插件）。 */
const DYNAMIC_IMPORT_EXEMPT = new Set(["plugins"]);

const LAYERS = new Set(Object.keys(ALLOWED));

function toPosix(p) {
  return sep === "/" ? p : p.split(sep).join("/");
}

/** 相对仓库根的路径。**用 `relative()` 而不是截字符串**：见下面「防空跑」那段。 */
function relOf(abs) {
  return toPosix(relative(ROOT, abs));
}

/** 相对 `src/` 的路径 —— 分层是按这个判的。 */
function srcRel(abs) {
  return toPosix(relative(SRC, abs));
}

/**
 * 一个「相对 src 的路径」属于哪一层。
 *
 * @returns 层名 | "composition-root" | null（null 只可能是**新出现的顶层目录**，那是违规，
 *          由规则 1a 报出来 —— 不再像初版那样当作「不属于任何层，所以不归我管」放过去）
 */
function layerOf(rel) {
  const top = rel.split("/")[0];
  if (LAYERS.has(top)) return top;
  if (COMPOSITION_ROOT.has(rel)) return "composition-root";
  return null;
}

/**
 * 收集 import 说明符。`import type` 也算：类型耦合同样会把方向定死。
 * 单引号与双引号都收（初版只认双引号，于是 `import x from '#api/server.ts'` 整条隐形）。
 *
 * @returns `Array<{ spec: string; typeOnly: boolean }>`
 */
function specifiersOf(text) {
  const found = [];
  const patterns = [
    { re: /(?:^|\n)\s*import\s+(type\s+)?[^"'"]*?from\s*["']([^"']+)["']/g, dyn: false },
    { re: /(?:^|\n)\s*export\s+(type\s+)?[^"'"]*?from\s*["']([^"']+)["']/g, dyn: false },
    { re: /\bimport\(\s*["']([^"']+)["']\s*\)/g, dyn: true },
  ];
  for (const { re, dyn } of patterns) {
    for (const m of text.matchAll(re)) {
      const spec = dyn ? m[1] : m[2];
      if (spec) found.push({ spec, typeOnly: dyn ? false : Boolean(m[1]) });
    }
  }
  return found;
}

/**
 * 说明符 → 「相对 src 的路径」。包名（`node:*`、`ws`、`@atri/shared`）返回 null 不归本检查管。
 *
 * 相对形式**必须先用文件所在目录归一化**：`./../../plugins/x.ts` 直接拿首段去比层会得到 `.`，
 * 于是它既不属于任何层、也不以 `../` 开头 —— 初版就是这样两头都不管。
 */
function toSrcPath(spec, fromFile) {
  if (spec.startsWith("#")) return spec.slice(1);
  if (spec.startsWith(".")) {
    const dir = posix.dirname(fromFile);
    return posix.normalize(dir === "." ? spec : `${dir}/${spec}`);
  }
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

  // 1a) 未知顶层目录本身就是一种违规，而不是一种豁免。
  if (fromLayer === null) {
    problems.push(
      `${relOf(abs)}：src/ 下出现了没有登记的目录「${from.split("/")[0]}/」—— ` +
        "要么它属于某一层（改名/挪位置），要么在 ALLOWED 里给它一张方向表。" +
        "不在表里的目录**不会**被放行（初版就是默认放行，于是新目录可以自由 import 任何上层）。",
    );
    continue;
  }

  const specs = specifiersOf(text);

  // 1b) 方向表（组合根不受限：它就是所有层的连线点）
  if (fromLayer !== "composition-root") {
    for (const { spec, typeOnly } of specs) {
      const target = toSrcPath(spec, from);
      if (target === null) continue;
      const toLayer = layerOf(target);
      if (toLayer === null) {
        // `../` 归一化之后可能已经跑出 src/（`core/./../../plugins/x.ts` 就是这种），
        // 那与「新目录」是两回事，话术要分开：前者是说明符写法问题，后者是层归属问题。
        problems.push(
          target.startsWith("..")
            ? `${relOf(abs)}：${spec} 归一化之后跑出了 src/（${target}）—— 跨目录请用 # 别名`
            : `${relOf(abs)}：${spec} 指向 src/ 下一个没有登记的目录 —— 先解决它属于哪一层`,
        );
        continue;
      }
      // 组合根认识所有层，所以 import 它等于**传递地** import 所有层。
      if (toLayer === "composition-root") {
        problems.push(
          `${relOf(abs)}：${fromLayer}/ 不得 import 组合根（${spec}）—— ` +
            "`app.ts` 认识每一层，这条边会让「core 不依赖上层」在传递依赖上直接失效",
        );
        continue;
      }
      if (toLayer === fromLayer) continue;
      edgesChecked += 1;
      if (!ALLOWED[fromLayer].has(toLayer)) {
        problems.push(`${relOf(abs)}: ${fromLayer}/ 不得 import ${toLayer}/（${spec}）`);
        continue;
      }
      if (TYPE_ONLY_ALLOWED_EDGES.has(`${fromLayer}->${toLayer}`) && !typeOnly) {
        problems.push(
          `${relOf(abs)}: ${fromLayer}/ 只能以 \`import type\` 读 ${toLayer}/（${spec}）—— ` +
            "需要那边的**实现**时由组合根注入，别 import 进来",
        );
      }
    }
  }

  // 2) 服务端不允许任何带 `..` 的相对说明符：跨目录改用 `#` 别名（AGENTS.md 的口径是
  //    「向上跳才用 #」）。判据是「路径里出现 .. 段」而不是「以 ../ 开头」，
  //    否则 `./../../x` 这一种就漏在规则 2 与规则 1 之间。
  // 3) 本地说明符必须带 `.ts`：服务端直接跑 .ts 源码，擦除不改写说明符，写 `.js` 就解析不到文件
  for (const { spec } of specs) {
    if (!spec.startsWith(".")) continue;
    if (spec.split("/").includes("..")) {
      problems.push(`${relOf(abs)}: 跨目录 import 请用 # 别名（${spec}）`);
    } else if (/\.(js|mjs)$/.test(spec)) {
      problems.push(`${relOf(abs)}: 本地说明符要写 .ts，服务端没有编译步骤（${spec}）`);
    }
  }

  // 4) 变量式动态 import：静态读不出说明符，这道检查对它无效。插件装载是**合法**的例外，
  //    其它层出现就是要往洞外面走，必须说清楚。
  if (!DYNAMIC_IMPORT_EXEMPT.has(fromLayer) && /\bimport\(\s*[^"')]/.test(text)) {
    problems.push(
      `${relOf(abs)}: 变量式动态 import（说明符不是字面量）—— 分层检查看不见它指向哪一层。` +
        "本仓只有 plugins/ 装载磁盘插件时允许这种写法",
    );
  }

  // 5) `#` 不能出现在 URL 解析里：那里它是片段分隔符，会静默得到错路径而不报错
  for (const m of text.matchAll(/new URL\(\s*["']([^"']*)["']/g)) {
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

// 6) `packages/shared` 不得配 `imports`：它的 exports/files 都指 dist/，
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
