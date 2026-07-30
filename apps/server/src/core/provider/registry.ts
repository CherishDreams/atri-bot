import type {
  ChatMessage,
  ChatOptions,
  ChatReply,
  ChatStreamOptions,
  ProviderImpl,
} from "./types.ts";

/** `list()` 的视图：注册表自己的调试/选路视图，与 API 层的 `ProviderInfo` 不是一个东西。 */
export interface RegistryEntry {
  id: string;
  name: string;
  models: string[];
  type: string;
  default: boolean;
}

/**
 * 模型 provider 注册表。具体实现（OpenAI 兼容、Anthropic、本地运行时）
 * 自行注册到这里；引擎从不 import 特定 SDK。
 * 新增一个 provider = 调用 register()，无需改动引擎。
 */
export class ProviderRegistry {
  #providers = new Map<string, ProviderImpl>();
  #defaultId: string | null = null;

  register(provider: ProviderImpl): ProviderImpl {
    if (!provider?.id) throw new Error("provider 必须带有 id");
    this.#providers.set(provider.id, provider);
    return provider;
  }

  /**
   * 清空注册表。用于配置变更后整表重建：provider 实例没有长连接、没有需要
   * 释放的资源，在途请求已经持有自己的实例引用，因此整体替换是安全的——
   * 那个请求会用它开始时的那份配置跑完，下一个请求才用新配置。
   */
  clear(): this {
    this.#providers.clear();
    this.#defaultId = null;
    return this;
  }

  get(id: string): ProviderImpl | null {
    return this.#providers.get(id) ?? null;
  }

  /** 设为默认 provider（未指定 model 时使用）。 */
  setDefault(id: string): this {
    this.#defaultId = id;
    return this;
  }

  get defaultId(): string | null {
    return this.#defaultId;
  }

  get size(): number {
    return this.#providers.size;
  }

  list(): RegistryEntry[] {
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
  async chat({ model, messages, signal }: ChatOptions): Promise<ChatReply> {
    const provider = this.#resolveFor(model);
    if (!provider) return echoReply(model, messages);
    return provider.chat({ model: this.#modelFor(provider, model), messages, signal });
  }

  /**
   * 流式补全。provider 未实现 `chatStream` 时退化为一次性回调整段文本，
   * 这样引擎无需为「这家支不支持流式」分叉。
   */
  async chatStream({ model, messages, onDelta, signal }: ChatStreamOptions): Promise<ChatReply> {
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
   * 选路：provider 实例 id > 本地列出的模型名 > 默认 provider > 第一个注册的。
   *
   * 为什么第一级是「实例 id」：前端模型选择器挑中的那一行就是一个 provider
   * 实例，它把实例 id 传上来。若只按模型名匹配，选了非默认实例时匹配不上，
   * 请求会静默落到默认 provider —— 而那个实例的模型名完全不搭，表现为
   * 「选了 A 却回了 B 的模型」，还查不出原因。
   *
   * 第二、三级保留原有回退：上游的模型名常常比配置里列的更全，
   * 本地列表只是一个提示，不该成为硬闸门。
   */
  #resolveFor(model: string | undefined): ProviderImpl | null {
    if (model) {
      const byId = this.#providers.get(model);
      if (byId) return byId;

      const byModel = [...this.#providers.values()].find((p) => p.models?.includes(model));
      if (byModel) return byModel;
    }

    if (this.#defaultId) {
      const preferred = this.#providers.get(this.#defaultId);
      if (preferred) return preferred;
    }

    return [...this.#providers.values()][0] ?? null;
  }

  /**
   * 定出真正发给上游的模型名。
   *
   * 传进来的可能是**实例 id**（模型选择器）或**模型名**（直接调 API），
   * 前者要换成该实例实际绑定的模型，否则会把 "deepseek/deepseek-chat"
   * 这种东西当模型名发给上游，上游回一句「模型不存在」。
   */
  #modelFor(provider: ProviderImpl, model: string | undefined): string | undefined {
    if (!model) return provider.models?.[0];
    if (model === provider.id) return provider.models?.[0] ?? model;
    return model;
  }
}

/** 未注册任何 provider 时的兜底，保证骨架可运行。 */
function echoReply(model: string | undefined, messages: ChatMessage[]): ChatReply {
  const last = messages.at(-1);
  return {
    role: "assistant",
    content: `[回声:${model ?? "默认"}] ${last?.content ?? ""}`,
  };
}
