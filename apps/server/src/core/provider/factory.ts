import type { Logger } from "#core/logger.ts";
import type {
  ProviderEntryConfig,
  ProvidersFileConfig,
  ProviderSourceEntryConfig,
} from "#config/file.ts";
import { errorMessage } from "#core/errors.ts";
import { OpenAIProvider } from "./openai.ts";
import { AnthropicProvider } from "./anthropic.ts";
import type { ProviderConstructor, ProviderImpl, ProviderOptions } from "./types.ts";

/**
 * 按配置构造 provider。
 *
 * 这里是「配置 → 实例」的唯一入口。把它从 ProviderRegistry 里拆出来，是因为
 * 注册表只该负责「存与取」，而「读配置、挑实现、解析密钥」是装配职责——
 * 混在一起会让注册表依赖具体的厂商实现。
 *
 * 配置是**两层**的（`atri.config.json`）：
 *
 * - `providerSources`：一次连接。`baseUrl` / `apiKey` / `timeoutMs` / `type`。
 * - `providers`：一个模型实例。`source` 指向某个源，外加 `model`。
 *
 * ```json
 * {
 *   "providerSources": {
 *     "deepseek": { "type": "openai", "baseUrl": "https://api.deepseek.com/v1", "apiKey": "" }
 *   },
 *   "providers": {
 *     "default": "deepseek-chat",
 *     "deepseek-chat": { "source": "deepseek", "model": "deepseek-chat" }
 *   }
 * }
 * ```
 *
 * 合并规则：`{ ...source, ...provider }`，**provider 级覆盖源级**（与 AstrBot 一致）。
 * 没有 `source` 键、自己带 `type` / `baseUrl` 的老写法仍然可用——此时「源」就是它自己，
 * 所以这次两层化不需要数据迁移。
 *
 * `default` 是保留键（字符串），不会被当成 provider。
 */

/** 认得的实现类型。写成表而不是 if-else，新增厂商只需加一行。 */
const TYPES: Record<string, ProviderConstructor> = {
  openai: OpenAIProvider,
  anthropic: AnthropicProvider,
};

/** 保留键：`providers.default` 存的是默认 provider 的 id，不是 provider 配置。 */
export const DEFAULT_PROVIDER_KEY = "default";

/** 「源 + 实例」合并后的形状。老的内联写法下源就是实例自己。 */
interface MergedConfig extends ProviderEntryConfig, ProviderSourceEntryConfig {}

/**
 * 从配置里解析出默认 provider 的 id。
 * 兼容两种写法：`providers.default` 字符串，或某个 provider 上的 `default: true`。
 */
export function readDefaultProviderId(providersConfig: ProvidersFileConfig = {}): string | null {
  const explicit = providersConfig[DEFAULT_PROVIDER_KEY];
  if (typeof explicit === "string" && explicit) return explicit;

  for (const [key, value] of Object.entries(providersConfig)) {
    if (key === DEFAULT_PROVIDER_KEY) continue;
    if (value && typeof value === "object" && value.default === true) return key;
  }
  return null;
}

interface CreateProvidersOptions {
  /** `providerSources` 段。 */
  sources?: Record<string, ProviderSourceEntryConfig>;
  logger?: Logger;
}

/**
 * 把配置段实例化成 provider 列表。
 *
 * 单个 provider 配错（未知 type、缺 key、引用了不存在的源）不会影响其它 provider：
 * 报错记进 `errors` 由调用方打日志，剩下的照常注册。否则一个手滑的 type 拼写
 * 会让整个服务起不来，而「其中一个 provider 坏了」本该是能局部降级的。
 *
 * `enabled: false` 是**有意关闭**，不算错误：跳过构造、不记进 `errors`，
 * 否则每次启动都会有一条「故障」日志，把真正的故障淹掉。
 */
export function createProviders(
  providersConfig: ProvidersFileConfig = {},
  { sources = {}, logger }: CreateProvidersOptions = {},
): { providers: ProviderImpl[]; errors: { id: string; message: string }[] } {
  const providers: ProviderImpl[] = [];
  const errors: { id: string; message: string }[] = [];

  for (const [id, raw] of Object.entries(providersConfig)) {
    if (id === DEFAULT_PROVIDER_KEY) continue;
    if (!raw || typeof raw !== "object") {
      errors.push({ id, message: "配置必须是对象" });
      continue;
    }

    // 两层合并：provider 级覆盖源级。没有 source 时 merged 就是 raw 自己，
    // 老的内联写法因此继续可用。
    let merged: MergedConfig = raw;
    if (typeof raw.source === "string" && raw.source) {
      const source = sources[raw.source];
      if (!source || typeof source !== "object") {
        errors.push({ id, message: `未找到 id 为「${raw.source}」的 provider source` });
        continue;
      }
      merged = { ...source, ...raw };
    }

    if (merged.enabled === false) {
      logger?.info(`provider 已禁用，跳过加载: ${id}`);
      continue;
    }

    const type = merged.type ?? "openai";
    const Impl = TYPES[type];
    if (!Impl) {
      errors.push({
        id,
        message: `未知的 provider 类型「${type}」，可用: ${Object.keys(TYPES).join(", ")}`,
      });
      continue;
    }

    try {
      const options = {
        ...merged,
        id,
        name: merged.name ?? id,
        // 一个 provider 就是一个模型实例：把它表达成「只有一个模型」的 provider，
        // 注册表的按模型选路（models.includes）便无需为两层结构改动。
        models: merged.model ? [merged.model] : (merged.models ?? []),
        // 密钥挂在源上（一个源一份凭证），环境变量也按源的 id 取。
        apiKey: resolveApiKey(raw.source ?? id, merged),
      } as ProviderOptions;
      // 上面那个 `as` 是**边界收窄**，不是糊错误：配置文件里的 provider 段是任意 JSON
      // （`FileConfig` 带索引签名，未知键原样透传），而构造器只认领 `ProviderOptions`
      // 里列出的那几个键。逐键校验发生在 `ProviderConfigStore` 写入时，这里不重复。
      // 之所以不逐键挑出来构造：那会逼 factory 认识每家的私有字段（`version`、`maxTokens`…），
      // 「新增厂商只需加一行 TYPES」这个性质就没了。
      const provider = new Impl(options);
      providers.push(provider);
      // `logger` 本身可以是 undefined（工厂被单测直接调用时不传），所以留 `logger?.`；
      // 但**方法上不再写 `?.`**：`Logger` 的四个方法与 child 都是必填的，
      // 那一级可选链在今天已经是不可达分支，留着会让读者以为「传个半套 logger 也没事」，
      // 而那种输入现在由编译期直接拒绝。
      logger?.info(
        `provider 已加载: ${id} (${type}${provider.models.length ? `, ${provider.models.length} 个模型` : ""})`,
      );
    } catch (err) {
      errors.push({ id, message: errorMessage(err) });
    }
  }

  return { providers, errors };
}

/**
 * 密钥解析顺序：provider 自己的 `apiKey` → 环境变量 `ATRI_<ID>_API_KEY`。
 *
 * `id` 传的是**源**的 id（两层结构下一份凭证属于一个源），内联老写法下就是
 * provider 自己的 id，两种情形都得到同一个变量名。
 *
 * 用环境变量而不是只认配置文件，是因为 `atri.config.json` 虽然已被 .gitignore
 * 忽略，但把明文密钥写在磁盘文件里仍然不如注入环境变量安全。
 */
function resolveApiKey(id: string, raw: MergedConfig): string {
  if (typeof raw.apiKey === "string" && raw.apiKey) return raw.apiKey;

  const envKey = `ATRI_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  return process.env[envKey] ?? "";
}
