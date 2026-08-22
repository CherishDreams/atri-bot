/**
 * 示例插件。把这个目录复制到 `apps/server/plugins/<name>/`
 * （或任意已配置的插件目录）即可加载。默认导出就是插件契约：
 *   { id, name, version, description, config?, setup(ctx), teardown() }
 * 也可以默认导出一个工厂函数 `(shared) => 上述对象`。
 *
 * `ctx` 提供：
 *   - logger：只读日志器
 *   - config：插件可见的配置（白名单视图，目前只有 pluginDirs），
 *     再合并上本插件自己声明的 `config` 段；口令与 provider 的 apiKey 不会到这里
 *   - ctx.effect(fn | {dispose()})：登记副作用，卸载时逆序自动释放
 *   - ctx.subscribe(emitter, event, handler)：订阅并在卸载时自动退订
 *   - ctx.plugins()：此刻已加载的插件（含你自己），每项只有 id / name / version /
 *     description / enabled。拿不到同伴的目录，也拿不到它们的加载失败原因；
 *     每次要就用现调用，别把结果存下来 —— 插件能在运行期被加载、重载与启停
 *
 * 把每个 ctx 字段都当作稳定 API —— 这是插件唯一能拿到的表面。
 */
export default {
  id: "hello",
  name: "示例插件",
  version: "0.1.0",
  description: "演示 ctx.effect：加载时启动定时器，卸载时自动清理。",

  async setup(ctx) {
    ctx.logger.info("[plugin:hello] 已就绪");

    // 使用 effect 登记副作用：插件被重载或卸载时，框架会自动清掉这个定时器，
    // 不需要在 teardown 里手动 clearInterval。
    const timer = setInterval(() => {
      ctx.logger.debug("[plugin:hello] 心跳");
    }, 60_000);
    ctx.effect(() => clearInterval(timer), "heartbeat");
  },

  async teardown() {
    // 需要在这里做的事已由 ctx.effect 处理；
    // 仅当有 effect 覆盖不到的清理时才需要覆写本方法。
  },
};
