/**
 * 模型 provider 注册表。具体实现（OpenAI 兼容、Anthropic、本地运行时）
 * 自行注册到这里；引擎从不 import 特定 SDK。
 * 新增一个 provider = 调用 register()，无需改动引擎。
 */
export class ProviderRegistry {
  #providers = new Map();
  /** @type {string | null} */
  #defaultId = null;

  constructor(config = {}) {
    this.config = config;
  }

  register(provider) {
    if (!provider?.id) throw new Error("provider 必须带有 id");
    this.#providers.set(provider.id, provider);
    return provider;
  }

  get(id) {
    return this.#providers.get(id) ?? null;
  }

  /** 设为默认 provider（未指定 model 时使用）。 */
  setDefault(id) {
    this.#defaultId = id;
    return this;
  }

  get defaultId() {
    return this.#defaultId;
  }

  get size() {
    return this.#providers.size;
  }

  list() {
    return [...this.#providers.values()].map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      models: p.models ?? [],
      type: p.type ?? "unknown",
      default: p.id === this.#defaultId,
    }));
  }

  /**
   * 发起一次对话补全。真实 provider 会覆盖此方法；
   * 默认实现返回确定性的回声，保证骨架可运行、不会直接崩掉。
   *
   * 注意：只有「一个 provider 都没注册」时才会走回声。一旦有 provider，
   * 调用失败必须抛错——把故障伪装成正常回复会让问题永远暴露不出来。
   */
  async chat({ model, messages, signal }) {
    const provider = this.#resolveFor(model);
    if (!provider) return echoReply(model, messages);
    return provider.chat({ model: this.#modelFor(provider, model), messages, signal });
  }

  /**
   * 流式补全。provider 未实现 `chatStream` 时退化为一次性回调整段文本，
   * 这样引擎无需为「这家支不支持流式」分叉。
   */
  async chatStream({ model, messages, onDelta, signal }) {
    const provider = this.#resolveFor(model);
    if (!provider) {
      const reply = echoReply(model, messages);
      onDelta?.(reply.content);
      return reply;
    }

    const resolved = this.#modelFor(provider, model);
    if (typeof provider.chatStream !== "function") {
      const reply = await provider.chat({ model: resolved, messages, signal });
      onDelta?.(reply.content ?? "");
      return reply;
    }
    return provider.chatStream({ model: resolved, messages, onDelta, signal });
  }

  /**
   * 选路：显式 model > 默认 provider > 第一个注册的 provider。
   *
   * 之所以要「默认 provider」这一层：前端目前不指定 model（模型选择器还是
   * 占位），若严格要求显式 model，所有请求都会立刻失败。三级回退保证
   * 零配置能跑、配置了默认值也更可控。
   */
  #resolveFor(model) {
    if (model) {
      const byModel = [...this.#providers.values()].find((p) => p.models?.includes(model));
      if (byModel) return byModel;
      // 模型名匹配不上时，退到默认 provider 并把 model 交给它——上游的模型名
      // 常常比配置里列的更全，本地列表只是一个提示，不该成为硬闸门。
    }

    if (this.#defaultId) {
      const preferred = this.#providers.get(this.#defaultId);
      if (preferred) return preferred;
    }

    return [...this.#providers.values()][0] ?? null;
  }

  /** provider 没有配 models 时，把调用方给的 model 原样传下去。 */
  #modelFor(provider, model) {
    if (model) return model;
    return provider.models?.[0];
  }
}

/** 未注册任何 provider 时的兜底，保证骨架可运行。 */
function echoReply(model, messages) {
  const last = messages.at(-1);
  return {
    role: "assistant",
    content: `[回声:${model ?? "默认"}] ${last?.content ?? ""}`,
  };
}
