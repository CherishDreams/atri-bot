import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 校验「注释里引用别的代码时没有用行号」。
 *
 * 为什么这条值得一个脚本：本仓把注释当设计史（AGENTS.md 的「注释写为什么」），
 * 而「文件名 + 冒号 + 行号」这种引用在一次 +73 行的改动之后**全部指错**，且没有任何信号 ——
 * 类型检查不认识注释，lint 不认识注释，测试也不认识。指错的引用比不写更坏：
 * 它会被当成事实读。AGENTS.md 现在要求写符号名，这里就是那条规矩的牙齿。
 *
 * 与 `check-codegen.mjs` 一样用 `git ls-files` 取范围：自动尊重 .gitignore，
 * 也不会去扫 node_modules 与构建产物。
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((f) => f.length > 0)
  // 生成物由 openapi-ts 产出，不该由人手守它的注释；它也不会写行号引用，写进来只是防一手。
  .filter((f) => !f.startsWith("apps/dashboard/src/api/generated/"));

/**
 * 要抓的形态：一个源码文件名 + 冒号 + 数字（可以带 `-` 区间）。
 *
 * 这里**不能**在注释或文档里写一个真实例子（比如某个 .ts 文件后跟冒号与数字）——
 * 那个例子会被这个正则自己抓到，于是这条检查第一次跑就红在自己的说明上。
 * 下面的模式串自己不构成匹配：`json` 与 `:` 之间隔着一个 `)`，而 `[0-9]` 里没有数字。
 */
const LINE_REF = /[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue|json):[0-9]+/g;

const hits = [];
let read = 0;
for (const rel of files) {
  // 用 `join` 而不是 `new URL(rel, ROOT)`：ROOT 是文件系统路径而不是 URL，
  // 拿它当 URL 基址会让每一次构造都抛，而那种写法一旦被 try/catch 吞掉，
  // 这个检查就变成「一个文件都没读，却报告 N 个文件通过」。
  const text = readFileSync(join(ROOT, rel), "utf8");
  read += 1;
  for (const m of text.matchAll(LINE_REF)) {
    hits.push(`${rel}: ${m[0]}`);
  }
}

/** 防空跑：读到的文件数必须与 `git ls-files` 给的数量一致，否则中间有文件被跳过了。 */
if (read !== files.length) {
  console.error(`引用检查自身有问题：应读 ${files.length} 个，实际读了 ${read} 个`);
  process.exit(1);
}
if (files.length < 50) {
  console.error(`引用检查自身有问题：只拿到 ${files.length} 个入库文件（git ls-files 是否正常？）`);
  process.exit(1);
}

if (hits.length) {
  console.error("发现按行号的交叉引用（会随改动失效，请改成符号名）：");
  for (const h of hits) console.error(`  ${h}`);
  console.error("\n写法见 AGENTS.md 的「注释写为什么」。");
  process.exit(1);
}

console.log(`引用检查通过：${files.length} 个入库文件里没有按行号的交叉引用。`);
