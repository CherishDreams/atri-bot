/**
 * 模型 provider 注册表。具体实现（OpenAI 兼容、Anthropic、本地运行时）
 * 自行注册到这里；引擎从不 import 特定 SDK。
 * 新增一个 provider = 调用 register()，无需改动引擎。
 */
export class ProviderRegistry {
  #providers = new Map();

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

  list() {
    return [...this.#providers.values()].map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      models: p.models ?? [],
    }));
  }

  /**
   * 发起一次对话补全。真实 provider 会覆盖此方法；
   * 默认实现返回确定性的回声，保证骨架可运行、不会直接崩掉。
   */
  async chat({ model, messages }) {
    const provider = this.#resolveFor(model);
    if (provider?.chat) return provider.chat({ model, messages });
    const last = messages.at(-1);
    return {
      role: "assistant",
      content: `[回声:${model ?? "默认"}] ${last?.content ?? ""}`,
    };
  }

  #resolveFor(model) {
    if (!model) return null;
    for (const p of this.#providers.values()) {
      if (p.models?.includes(model)) return p;
    }
    return null;
  }
}
