# 跨包 / 集成测试

本目录预留给**跨包**的测试（需要同时用到 `apps/server` 与 `apps/dashboard`，或需要真实进程边界的用例）。

**单个包自己的测试不放在这里**，而是跟代码同包：

- `apps/server/test/*.test.ts` —— 服务端单元测试与端到端冒烟（`pnpm --filter @atri/server test`）
- `apps/dashboard` —— 目前没有单测，`pnpm test` 只跑 `vue-tsc --noEmit`

服务端与 `packages/shared` 用内置的 `node:test` 运行器，不引入任何测试框架依赖。
`apps/dashboard` **不在**这一列：它的 `test` 脚本是 `vue-tsc --noEmit`，没有单测，
所以前端行为必须在真浏览器里验证（见 `AGENTS.md` 的「验证纪律」）。
`packages/shared` 那条脚本目前跑出 0 条用例 —— 线协议（`protocol.ts` 的帧类型）的守卫
住在 `apps/server/test/protocol-frames.test.ts`，因为它需要读服务端源码。
测试写法与约定见仓库根的 `AGENTS.md`。
