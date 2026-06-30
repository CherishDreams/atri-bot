import { defineConfig } from "@hey-api/openapi-ts";

/**
 * OpenAPI → 前端类型化客户端的生成配置。
 *
 * 契约的唯一来源是 `apps/server/openapi.json`：服务端拥有它，前端由它生成。
 * 生成的代码**入库**（它是被应用直接 import 的源码，不是临时产物），因此
 * 走 `pnpm codegen` 之后必须没有 diff——`pnpm codegen:check` 就是守这条线。
 *
 * 两个刻意的选择：
 * - **不设 `output.format`**：默认会用 prettier，而本仓用 oxfmt。设了会因为
 *   找不到 prettier 可执行文件直接失败。生成目录改为对整个仓库的
 *   oxlint/oxfmt 豁免（见 `.oxlintrc.json` 与 `.oxfmtrc.json`）。
 * - **不设 `runtimeConfigPath`**：它把相对路径按 `process.cwd()` 解析后再折算成
 *   import 说明符，很容易生成指向仓库根的坏 import。改为生成物保持原样，
 *   配置 axios 实例的事放在手写的 `src/api/client.ts` 里做。
 */
export default defineConfig({
  input: "apps/server/openapi.json",
  output: {
    path: "apps/dashboard/src/api/generated",
    // 生成物不参与 git 之外的任何后处理，保持与上游生成器逐字节一致，
    // 这样「重新生成后 diff 为空」才是可信的漂移检查。
    clean: true,
  },
  plugins: ["@hey-api/typescript", "@hey-api/sdk", "@hey-api/client-axios"],
});
