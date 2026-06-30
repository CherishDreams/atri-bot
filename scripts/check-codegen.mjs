import { execFileSync } from "node:child_process";

/**
 * 校验「按 openapi.json 重新生成后，入库的生成物没有任何变化」。
 *
 * 用 `git status --porcelain` 而不是 `git diff`：`git diff` 看不见未跟踪文件，
 * 于是新增一个接口、生成物多出一个文件时，漂移检查会照样通过——那正是
 * 最需要它报警的情况。porcelain 同时覆盖修改、删除与新增。
 */
const TARGET = "apps/dashboard/src/api/generated";

const output = execFileSync("git", ["status", "--porcelain", "--", TARGET], {
  encoding: "utf8",
}).trim();

if (output) {
  console.error(`生成物与 openapi.json 不同步，请提交重新生成的结果：\n${output}\n`);
  process.exit(1);
}

console.log("生成物与 openapi.json 保持一致。");
