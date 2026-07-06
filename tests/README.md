# 跨包 / 集成测试

本目录预留给**跨包**的测试（需要同时用到 `apps/server` 与 `apps/dashboard`，或需要真实进程边界的用例）。

**单个包自己的测试不放在这里**，而是跟代码同包：

- `apps/server/test/*.test.js` —— 服务端单元测试与端到端冒烟（`pnpm --filter @atri/server test`）
- `apps/dashboard` —— 目前没有单测，`pnpm test` 只跑 `vue-tsc --noEmit`

三者都用内置的 `node:test` 运行器，不引入任何测试框架依赖。
测试写法与约定见仓库根的 `AGENTS.md`。
