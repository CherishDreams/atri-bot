import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 主题覆盖的键名必须真的存在于 naive-ui —— 这道检查是第四种「编译器与测试都看不见」。
 *
 * 为什么 `pnpm --filter @atri/dashboard typecheck` 拦不住这件事：naive-ui 的
 * `GlobalThemeOverrides` 里每个组件那一格是 `ExtractThemeOverrides<…>`，实测（v2.45.3）
 * 它接受任意键 —— 往 `Form` 里塞 `totallyFakeKey` 与 `Menu.itemIconMargin` 都 typecheck 全绿，
 * 而 naive-ui 对不认识的键**静默忽略**：既没有警告也没有报错，只有外观没变。
 * 本仓已经因此漏过两个 bug（AGENTS.md 的「验证纪律」一节），而主题这一类比布局更难被发现 ——
 * 它只会让「某个控件的字重/间距跟设计稿不一样」。
 *
 * 实测例证（本次改动查出来的两条）：
 * - `Form.labelFontWeightStrong` 不存在，真名是 `labelFontWeight`。
 * - `Menu.itemIconMargin` 不存在：Menu 根本没有 margin 类自有键，那个间距只能靠
 *   CSS 覆盖内部类（`TopBarMenu.vue` 里就有一段这样的处理）。
 *
 * 判据来自运行时自省而不是我抄一份名单：`lightTheme` 上每个组件主题的
 * `self(commonLight)` 就是这个组件**实际能被覆盖**的键集合。抄名单会变成第五份真源。
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const THEME_FILE = join(ROOT, "apps/dashboard/src/theme/naive.ts");
/**
 * 从 `apps/dashboard` 那侧解析 `naive-ui`：pnpm 不 hoist 依赖，从 `scripts/` 直接
 * `import("naive-ui")` 会 `ERR_MODULE_NOT_FOUND`（实测）。用 dashboard 的 package.json
 * 当解析起点，判据就仍然来自**那个真正用到它的包**所装的版本，而不是另装一份。
 */
const NAIVE = createRequire(join(ROOT, "apps/dashboard/package.json"))("naive-ui");

const { lightTheme, commonLight } = NAiveOrThrow(NAIVE);

function NAiveOrThrow(mod) {
  if (!mod.lightTheme || !mod.commonLight) {
    console.error(
      "naive-ui 的导出形状变了（lightTheme / commonLight 取不到），这道检查的判据没了。",
    );
    process.exit(1);
  }
  return mod;
}

/** 组件名 → 它自有（self）主题键的集合。`common` 与 `name` 不是组件，跳过。 */
function componentVarKeys() {
  const out = new Map();
  out.set("__common__", new Set(Object.keys(commonLight)));
  for (const [name, theme] of Object.entries(lightTheme)) {
    if (name === "name" || name === "common") continue;
    if (!theme || typeof theme !== "object" || typeof theme.self !== "function") continue;
    const vars = theme.self(commonLight);
    // `peers` 那一格是「对端组件的键」，不是本组件的自有键，单独拿出来当目录用。
    const own = Object.keys(vars).filter((k) => k !== "peers");
    out.set(name, new Set(own));
  }
  return out;
}

const TABLE = componentVarKeys();

/**
 * 从 `naive.ts` 里抽出「组件 → 被覆盖的键」。
 *
 * 靠缩进而非 AST：本仓由 `.oxfmtrc.json` 把格式钉死（2 空格一级），
 * 所以「键在第几层」是一个结构性事实，与 `check-layering.mjs` 认说明符前缀同一类判据。
 * 缩进一旦不再等于层数，这个解析器会解析出 0 条 —— 下面的防空跑断言会立刻说破。
 */
function overridesIn(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("function buildComponents("));
  if (start === -1) {
    console.error("naive.ts 里找不到 buildComponents —— 判据得跟着改，而不是让它空跑。");
    process.exit(1);
  }
  const found = [];
  let component = null;
  let peer = null;
  for (const line of lines.slice(start)) {
    const m = line.match(/^( +)([A-Za-z][A-Za-z0-9]*)(\??): (.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2];
    const value = m[4];
    if (indent === 4) {
      // 组件名那一行以 `{` 收尾；其它 4 空格键（`const sh = …` 之类）不是覆盖项。
      component = value.trim() === "{" ? key : null;
      peer = null;
      if (component) found.push({ kind: "component", name: component });
      continue;
    }
    if (indent === 6 && component) {
      if (key === "peers") {
        peer = "pending";
        continue;
      }
      peer = null;
      found.push({ kind: "own", name: component, key });
      continue;
    }
    if (indent === 8 && peer) {
      peer = key;
      found.push({ kind: "peer-name", name: component, peer: key });
      continue;
    }
    if (indent === 10 && peer) {
      found.push({ kind: "peer-key", name: component, peer, key });
    }
  }
  return found;
}

/** common 那一段（`const c: Record<string, string> = { … }`，键在 4 空格）。 */
function commonKeys(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.includes("const c: Record<string, string> = {"));
  if (start === -1) return [];
  const keys = [];
  for (const line of lines.slice(start + 1)) {
    // 这一段是函数体里的对象字面量，结束标志是缩进 ≤2 的 `}`（`buildCommon` 的收尾是
    // 顶格的 `}`，所以这里不能只匹配「有前导空白的 }」，否则解析会一路读到组件区）。
    if (/^\s{0,2}}/.test(line)) break;
    const m = line.match(/^ {4}([A-Za-z][A-Za-z0-9]*): /);
    if (m?.[1]) keys.push(m[1]);
  }
  return keys;
}

const text = readFileSync(THEME_FILE, "utf8");
const overrides = overridesIn(text);
const commons = commonKeys(text);
const problems = [];

for (const key of commons) {
  if (!TABLE.get("__common__")?.has(key)) {
    problems.push(`common.${key} 不是 naive-ui 的 common 变量（写错一个字母就静默失效）`);
  }
}

for (const o of overrides) {
  if (o.kind === "component" || o.kind === "peer-name") {
    const name = o.kind === "component" ? o.name : o.peer;
    if (!TABLE.has(name)) problems.push(`${name} 不是 naive-ui 的组件主题名（覆盖会被整个忽略）`);
    continue;
  }
  const set = TABLE.get(o.name);
  if (!set) continue; // 组件名不存在时上面已经报过了
  if (o.kind === "own" && !set.has(o.key)) {
    problems.push(`${o.name}.${o.key} 不是 ${o.name} 的自有主题键 —— 静默不生效`);
  }
  if (o.kind === "peer-key") {
    const peerSet = TABLE.get(o.peer);
    // peers 里对端组件的键**不必**是它自己的自有键（阴影那类要从 `peers` 传下去），
    // 所以这里只要求那个组件名存在（上面已查），键名不比对，避免误报。
    if (peerSet && peerSet.size === 0) {
      problems.push(`peers.${o.peer} 没有可自省的变量表，无法检查 ${o.key}`);
    }
  }
}

/** 防空跑：解析不出东西就等于这道检查没在看任何真实内容。 */
if (overrides.length < 20 || commons.length < 10 || TABLE.size < 40) {
  console.error(
    `主题键检查自身有问题：解析到 ${overrides.length} 条覆盖、${commons.length} 个 common 键、` +
      `${TABLE.size} 个组件变量表（缩进或 naive-ui 的形状变了？），不检查就说「通过」是本仓最恨的那种绿。`,
  );
  process.exit(1);
}

if (problems.length) {
  console.error("主题覆盖里有 naive-ui 不认识的键：");
  for (const p of new Set(problems)) console.error(`  ${p}`);
  console.error(
    "\n判据来自 naive-ui 运行时（lightTheme[x].self(commonLight)），理由见 docs/architecture.md 的主题一节。",
  );
  process.exit(1);
}

console.log(
  `主题键检查通过：${overrides.length} 条组件覆盖、${commons.length} 个 common 键，键名都在 naive-ui 的变量表里。`,
);
