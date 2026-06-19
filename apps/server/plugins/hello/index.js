/**
 * 示例插件。把这个目录复制到 `apps/server/plugins/<name>/`
 * （或任意已配置的插件目录）即可加载。默认导出就是插件契约：
 * `{ id, name, version, setup(ctx), teardown() }`。
 *
 * `ctx` 当前暴露 `logger` 和 `config`。把 ctx 的每个字段都当作稳定 API ——
 * 这是插件唯一能拿到的表面。
 */
export default {
  id: "hello",
  name: "示例插件",
  version: "0.1.0",
  description: "加载时打印一行日志；真实插件的模板。",

  async setup(ctx) {
    ctx.logger.info("[plugin:hello] 已就绪");
  },

  async teardown() {
    // 在这里释放定时器、socket、订阅等资源
  },
};
