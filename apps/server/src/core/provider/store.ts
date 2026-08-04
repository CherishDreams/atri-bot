/**
 * provider 配置的运行时存储。
 *
 * 这里承担「界面能改配置」这件事的**唯一**写入路径：读 `atri.config.json`、
 * 校验、改 `providerSources` / `providers` 两个键、写回；随后由调用方
 * 重建注册表让改动立刻生效。
 *
 * ## 为什么是两层
 *
 * 一个**源**（source）是一次连接的描述：`baseUrl` / `apiKey` / `timeoutMs`。
 * 一个 **provider** 是一个可选的模型实例：引用某个源，再指定 `model`。
 * 同一源下的多个模型因此共享一份凭证与超时——改密钥只改一处。
 * 这也是 AstrBot 的结构（provider_source + provider），照搬可以少发明一套语义。
 *
 * 合并规则与 AstrBot 一致：`{ ...source, ...provider }`，**provider 级覆盖源级**。
 *
 * ## 兼容
 *
 * `providers` 里没有 `source` 键、自己带 `type` / `baseUrl` 的老写法继续可用，
 * 此时「源」就是它自己。因此这次改动不需要数据迁移。
 *
 * ## 落盘策略
 *
 * 只改这两个键，文件里其余内容原样保留。文件损坏时**拒绝写入**而不是当成
 * 空配置覆盖——那会把用户其它配置一起丢掉。
 */
import type { Logger } from "../logger.ts";
import type {
  FileConfig,
  ProviderEntryConfig,
  ProvidersFileConfig,
  ProviderSourceEntryConfig,
} from "../../config/file.ts";
import { configFilePath, readConfigFile, updateConfigFile } from "../../config/file.ts";
import { errorMessage } from "../errors.ts";

/** 认得的 provider 实现类型。与 factory.ts 的 TYPES 保持同步。 */
export const PROVIDER_TYPES: readonly string[] = ["openai", "anthropic"];

/** provider 的保留 id：`providers.default` 存的是默认项的 id，不能用它当 provider 名。 */
const RESERVED_PROVIDER_ID = "default";

/** 源与 provider 的 id 都限制在这套字符里，避免出现会让 URL 与日志难以阅读的名字。 */
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** 超时上下限（毫秒）。下限防 `AbortSignal.timeout(0)` 那种「立即中止」。 */
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;

/** provider 实例上允许被写入的键。patch 里出现别的键一律忽略。 */
const PROVIDER_KEYS = ["source", "model", "name", "enabled", "default"];

/** 源上允许被写入的键。 */
const SOURCE_KEYS = ["type", "name", "baseUrl", "apiKey", "timeoutMs"];

/** 供 UI 与文档复用的默认超时。与两个实现类的构造默认值一致。 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 配置不合法。带上 `field` 供前端把错误定位到具体输入框，
 * `status` 则由 API 层直接用作响应码——比让调用方拿 message 做字符串匹配可靠。
 */
export class ProviderConfigError extends Error {
  field: string;
  status: number;

  constructor(field: string, message: string, status = 400) {
    super(message);
    this.name = "ProviderConfigError";
    this.field = field;
    this.status = status;
  }
}

/**
 * 返回 `never` 而不是 `void`：这两个函数**从不返回**，标成 never 之后
 * 调用点后面的代码才被控制流分析认为不可达。
 *
 * 这不是纸面功夫——`assertBaseUrl()` 里 `catch { fail(...) }` 之后接着用 `parsed.protocol`，
 * 那个「fail 之后不会再往下走」的不变量今天只靠人肉眼维持，`never` 把它变成机器可查的。
 */
function fail(field: string, message: string): never {
  throw new ProviderConfigError(field, message);
}

/** 未找到目标（源或 provider）。 */
function notFound(field: string, message: string): never {
  throw new ProviderConfigError(field, message, 404);
}

/**
 * 写入入参：任意 JSON 对象。
 *
 * 刻意不收成 `ProviderSourceInput` 之类的精确形状：值来自 HTTP 请求体，
 * 而「拒绝非法 type / 非法 timeoutMs / 非法 id」**本身就是被测行为**
 * （`test/provider-config.test.ts` 专门传 `type: "bogus"`、`id: "有空格 的 id"`）。
 * 把入参收窄等于让那些负例用例写不出来，也等于让类型系统取代运行时校验——
 * 而运行时校验才是唯一的真相来源。返回值才收窄（见 `createSource`）。
 */
export type WriteInput = Record<string, unknown>;

/** 磁盘上的源条目（`id` 就是它在映射里的键，因此读出来时补上）。 */
export type SourceEntry = ProviderSourceEntryConfig & { id: string };

/** 磁盘上的 provider 实例条目。 */
export type ProviderEntry = ProviderEntryConfig & { id: string };

/** ProviderConfigStore 实际读写的配置键（不直接用 AppConfig，见 config/config.ts 的说明）。 */
export interface ProviderStoreConfig {
  /**
   * 可以缺省：直接用代码构造 config 的调用方（测试、嵌入式使用）没有配置文件可写，
   * 此时整个存储退化为**只读内存视图**。
   */
  root?: string;
  providers?: ProvidersFileConfig;
  providerSources?: Record<string, ProviderSourceEntryConfig>;
}

function assertId(value: unknown, field = "id"): string {
  if (typeof value !== "string" || value.length === 0) fail(field, "必须提供 id（字符串）");
  if (!ID_PATTERN.test(value)) {
    fail(field, `id「${value}」含有非法字符，只允许字母、数字、点、下划线与连字符`);
  }
  return value;
}

/**
 * 返回 `string` 而不是 `ProviderType` 联合：这个值只是被原样写进配置，
 * 真正「按类型挑实现」发生在 `factory.ts` 的 `TYPES` 查表处，那里才需要联合。
 */
function assertType(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_TYPES.includes(value)) {
    fail("type", `未知的 provider 类型「${value}」，可用: ${PROVIDER_TYPES.join(", ")}`);
  }
  return value;
}

function assertBaseUrl(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") fail("baseUrl", "baseUrl 必须是字符串");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("baseUrl", `baseUrl「${value}」不是合法的 URL`);
  }
  // 上面那个 catch 分支以 fail() 收尾（never），所以这里 parsed 必然已赋值。
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("baseUrl", "baseUrl 只能使用 http 或 https");
  }
  return value;
}

/** 超时用毫秒，与实现类的 `timeoutMs` 同名同单位，避免半套换算。 */
function assertTimeout(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail("timeoutMs", "timeoutMs 必须是整数（毫秒）");
  }
  if (value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    fail("timeoutMs", `timeoutMs 必须在 ${MIN_TIMEOUT_MS} 与 ${MAX_TIMEOUT_MS} 毫秒之间`);
  }
  return value;
}

function assertModel(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("model", "必须提供 model（上游的模型 ID）");
  }
  return value.trim();
}

/** 只保留允许的键，并丢弃 `undefined`，使 patch 的语义是「出现即覆盖」。 */
function pick(raw: WriteInput, keys: readonly string[]): WriteInput {
  const out: WriteInput = {};
  for (const key of keys) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

/**
 * provider 与源的配置存储。所有方法都是同步的：配置是小文件，
 * 每次改动读-改-写的代价远低于把状态缓存起来再处理一致性。
 *
 * ## 读的是哪一份配置
 *
 * 以**文件**为准，因为界面改的就是文件。但有个例外必须处理：调用方
 * 直接用代码构造 config（测试、嵌入使用）时根本没有那个文件，
 * 此时退回**注入的** `config.providers` / `config.providerSources`。
 *
 * 判据是「文件里是否出现了这两个键之一」而不是「文件是否存在」，
 * 这样在同一个 root 下从零创建配置（文件存在但还没写 provider 段）
 * 仍然以注入值为起点，不会把配置凭空读空。
 */
export class ProviderConfigStore {
  #root: string | null;
  #logger: Logger | undefined;
  #baseline: {
    providerSources: Record<string, ProviderSourceEntryConfig>;
    providers: ProvidersFileConfig;
  };

  constructor(config: ProviderStoreConfig, logger?: Logger) {
    this.#root = config.root ?? null;
    this.#logger = logger;
    this.#baseline = {
      providerSources: config.providerSources ?? {},
      providers: config.providers ?? {},
    };
  }

  /** 配置文件绝对路径；没有 `root` 时为 null（只读模式）。 */
  get filePath(): string | null {
    return this.#root ? configFilePath(this.#root) : null;
  }

  /** 是否可写。没有 `root` 时只能读注入进来的配置。 */
  get writable(): boolean {
    return this.#root !== null;
  }

  /** 当前生效的 `{providerSources, providers}`。 */
  #current(): {
    providerSources: Record<string, ProviderSourceEntryConfig>;
    providers: ProvidersFileConfig;
  } {
    if (!this.#root) return { ...this.#baseline };
    const file = readConfigFile(this.#root);
    const hasProviders = Object.hasOwn(file, "providers");
    const hasSources = Object.hasOwn(file, "providerSources");
    if (!hasProviders && !hasSources) return { ...this.#baseline };
    return {
      providerSources: file.providerSources ?? {},
      providers: file.providers ?? {},
    };
  }

  /**
   * 全部源（深拷贝，外部改动不会影响下一次写入）。
   *
   * 类型是 `SourceEntry` 而不是 `shared.ProviderSource`：后者是**对外承诺的完整形状**，
   * 而这里的字段是否齐全取决于配置文件是谁写的（本类写入的一定全，
   * 手改进去的可能缺）。宁可如实保留可选，也不在类型里骗人。
   */
  get sources(): SourceEntry[] {
    const raw = this.#current().providerSources;
    return Object.entries(raw).map(([id, value]) => ({ id, ...value }));
  }

  /** 全部 provider 实例（深拷贝）。同理见 `sources`。 */
  get providers(): ProviderEntry[] {
    const raw = this.#current().providers;
    return (
      Object.entries(raw)
        .filter(([id]) => id !== RESERVED_PROVIDER_ID)
        // 边界收窄：非保留键的值按形状就是实例对象。（今天若真遇到字符串值，
        // 展开会产出 `{id, 0:"b", 1:"a"…}` 这种垃圾，那是既有行为，不在迁移里改。）
        .map(([id, value]) => ({ id, ...(value as ProviderEntryConfig) }))
    );
  }

  /** 默认 provider 的 id；没有则 null。 */
  get defaultId(): string | null {
    const value = this.#current().providers[RESERVED_PROVIDER_ID];
    return typeof value === "string" && value ? value : null;
  }

  getSource(id: string): SourceEntry | null {
    return this.sources.find((s) => s.id === id) ?? null;
  }

  getProvider(id: string): ProviderEntry | null {
    return this.providers.find((p) => p.id === id) ?? null;
  }

  /**
   * 已被注册进注册表的那份配置形状：`iterable` 条目可以直接交给
   * `createProviders`。实例上补 `source`，使 factory 能取到源级字段。
   */
  providerEntries(): ProvidersFileConfig {
    const entries: ProvidersFileConfig = {};
    for (const provider of this.providers) {
      const { id, ...rest } = provider;
      entries[id] = rest;
    }
    const defaultId = this.defaultId;
    if (defaultId) entries[RESERVED_PROVIDER_ID] = defaultId;
    return entries;
  }

  /** 源的映射形状，交给 `createProviders` 的 `sources` 参数。 */
  sourceEntries(): Record<string, ProviderSourceEntryConfig> {
    const entries: Record<string, ProviderSourceEntryConfig> = {};
    for (const { id, ...rest } of this.sources) entries[id] = rest;
    return entries;
  }

  // --- 源 -----------------------------------------------------------------

  createSource(input: WriteInput = {}): SourceEntry {
    const id = assertId(input.id);
    const type = assertType(input.type ?? "openai");
    const source: ProviderSourceEntryConfig = {
      type,
      name: typeof input.name === "string" && input.name ? input.name : id,
      baseUrl: assertBaseUrl(input.baseUrl),
      apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
      timeoutMs: assertTimeout(input.timeoutMs),
    };

    return this.#write((config) => {
      const sources = config.providerSources ?? {};
      if (Object.hasOwn(sources, id)) fail("id", `已存在 id 为「${id}」的 provider source`);
      config.providerSources = { ...sources, [id]: source };
      return { id, ...source };
    });
  }

  updateSource(id: string, patch: WriteInput = {}): SourceEntry {
    const edit = pick(patch, SOURCE_KEYS);
    return this.#write((config) => {
      const sources = config.providerSources ?? {};
      const current = sources[id];
      if (!current) notFound("id", `未找到 id 为「${id}」的 provider source`);

      const next: ProviderSourceEntryConfig = { ...current };
      if (edit.type !== undefined) next.type = assertType(edit.type);
      if (edit.name !== undefined) next.name = String(edit.name);
      if (edit.baseUrl !== undefined) next.baseUrl = assertBaseUrl(edit.baseUrl);
      if (edit.apiKey !== undefined) {
        if (typeof edit.apiKey !== "string") fail("apiKey", "apiKey 必须是字符串");
        next.apiKey = edit.apiKey;
      }
      if (edit.timeoutMs !== undefined) next.timeoutMs = assertTimeout(edit.timeoutMs);

      config.providerSources = { ...sources, [id]: next };
      return { id, ...next };
    });
  }

  /**
   * 删除源。仍被 provider 引用时默认**拒绝**，因为静默级联会悄悄删掉
   * 用户配好的模型并在下次请求时才暴露。`cascade` 显式要求时才连带删除。
   */
  deleteSource(id: string, { cascade = false }: { cascade?: boolean } = {}): { deleted: string[] } {
    return this.#write((config) => {
      const sources = config.providerSources ?? {};
      if (!Object.hasOwn(sources, id)) notFound("id", `未找到 id 为「${id}」的 provider source`);

      const providers = config.providers ?? {};
      const referencedBy = Object.entries(providers)
        .filter(([key, value]) => {
          if (key === RESERVED_PROVIDER_ID) return false;
          return value && typeof value === "object" && value.source === id;
        })
        .map(([key]) => key);

      if (referencedBy.length > 0 && !cascade) {
        fail(
          "id",
          `provider source「${id}」仍被这些 provider 引用：${referencedBy.join(
            "、",
          )}。请先删除它们，或改用级联删除。`,
        );
      }

      const nextSources = { ...sources };
      delete nextSources[id];
      config.providerSources = nextSources;

      const deleted = [id];
      if (referencedBy.length > 0) {
        const nextProviders = { ...providers };
        for (const key of referencedBy) delete nextProviders[key];
        if (nextProviders[RESERVED_PROVIDER_ID] !== undefined) {
          // 保留键的值一定是字符串（它是某个 provider 的 id），这里的 typeof 只为收窄类型。
          const reserved = nextProviders[RESERVED_PROVIDER_ID];
          const stillThere = typeof reserved === "string" && referencedBy.includes(reserved);
          if (stillThere) delete nextProviders[RESERVED_PROVIDER_ID];
        }
        config.providers = nextProviders;
        deleted.push(...referencedBy);
      }

      return { deleted };
    });
  }

  // --- provider 实例 ------------------------------------------------------

  createProvider(input: WriteInput = {}): ProviderEntry {
    const id = assertId(input.id);
    if (id === RESERVED_PROVIDER_ID) {
      fail("id", `「${RESERVED_PROVIDER_ID}」是保留键（指向默认 provider），不能作为 provider id`);
    }
    const provider = this.#buildProvider(input, id);

    return this.#write((config) => {
      const providers = config.providers ?? {};
      if (Object.hasOwn(providers, id)) fail("id", `已存在 id 为「${id}」的 provider`);
      this.#assertSourceExists(config, provider.source);
      config.providers = { ...providers, [id]: provider };
      return { id, ...provider };
    });
  }

  updateProvider(id: string, patch: WriteInput = {}): ProviderEntry {
    const edit = pick(patch, PROVIDER_KEYS);
    return this.#write((config) => {
      const providers = config.providers ?? {};
      if (id === RESERVED_PROVIDER_ID)
        fail("id", `「${RESERVED_PROVIDER_ID}」是保留键，不是 provider`);
      // `providers` 的值既可能是实例、也可能是保留键 `default` 的字符串，
      // 而上一条检查已经排除 `id === "default"`，所以这里取到的一定是对象那一支。
      const current = providers[id] as ProviderEntryConfig;
      if (!current) notFound("id", `未找到 id 为「${id}」的 provider`);

      const next: ProviderEntryConfig = { ...current };
      if (edit.source !== undefined) next.source = assertId(edit.source, "source");
      if (edit.model !== undefined) next.model = assertModel(edit.model);
      if (edit.name !== undefined) next.name = String(edit.name);
      if (edit.enabled !== undefined) {
        if (typeof edit.enabled !== "boolean") fail("enabled", "enabled 必须是布尔值");
        next.enabled = edit.enabled;
      }
      if (next.source) this.#assertSourceExists(config, next.source);

      const nextProviders = { ...providers, [id]: next };
      // 同一个字段既能写进 provider 也能当保留键：`{default: true}` 就地设为默认，
      // `{default: false}` 只有在它本来就是默认项时才清掉。
      if (edit.default === true) {
        nextProviders[RESERVED_PROVIDER_ID] = id;
      } else if (edit.default === false && nextProviders[RESERVED_PROVIDER_ID] === id) {
        delete nextProviders[RESERVED_PROVIDER_ID];
      }
      config.providers = nextProviders;
      return { id, ...next, default: nextProviders[RESERVED_PROVIDER_ID] === id };
    });
  }

  deleteProvider(id: string): { deleted: string } {
    return this.#write((config) => {
      const providers = config.providers ?? {};
      if (!Object.hasOwn(providers, id) || id === RESERVED_PROVIDER_ID) {
        notFound("id", `未找到 id 为「${id}」的 provider`);
      }
      const nextProviders = { ...providers };
      delete nextProviders[id];
      // 删掉的正是默认项时必须清掉保留键，否则选路会指向一个不存在的 id。
      if (nextProviders[RESERVED_PROVIDER_ID] === id) {
        delete nextProviders[RESERVED_PROVIDER_ID];
        this.#logger?.warn(
          `已删除默认 provider「${id}」，默认项已清空，选路将退回第一个可用的 provider`,
        );
      }
      config.providers = nextProviders;
      return { deleted: id };
    });
  }

  // --- 内部 ---------------------------------------------------------------

  #buildProvider(input: WriteInput, id: string): ProviderEntryConfig {
    const provider: ProviderEntryConfig = { model: assertModel(input.model) };
    if (input.source !== undefined) provider.source = assertId(input.source, "source");
    provider.name = typeof input.name === "string" && input.name ? input.name : id;
    // 默认启用：AstrBot 的默认是 false，但那样一来「配置里明明有、就是选不到」
    // 会变成一个很难自查的困惑，而这里的默认值不该继承那种历史包袱。
    provider.enabled = input.enabled === undefined ? true : Boolean(input.enabled);
    return provider;
  }

  #assertSourceExists(config: FileConfig, sourceId: string | undefined): void {
    if (!sourceId) return; // 内联老写法：自己带 type/baseUrl，不需要源
    const sources = config.providerSources ?? {};
    if (!Object.hasOwn(sources, sourceId)) {
      fail("source", `未找到 id 为「${sourceId}」的 provider source`);
    }
  }

  /**
   * 一次读-改-写。`mutate` 里的校验失败会直接抛出，文件完全不被触碰。
   *
   * 起点是 `#current()` 而不是直接读文件：注入式配置（测试、嵌入式使用）
   * 下没有配置文件，从空对象起步会把调用方给的 provider 全部写没。
   */
  #write<T>(mutate: (config: FileConfig) => T): T {
    if (!this.#root) {
      // 只读模式下的写操作是调用方的用法错误，明确报错而不是静默丢弃。
      throw new ProviderConfigError(
        "root",
        "当前配置没有落盘位置（config.root 未设置），无法保存 provider 配置",
        400,
      );
    }
    try {
      return updateConfigFile(this.#root, (file) => {
        const base =
          Object.hasOwn(file, "providers") || Object.hasOwn(file, "providerSources")
            ? file
            : { ...file, ...this.#baseline };
        // 就地改：让 mutate 看到的是同一份合并后的配置，因此校验
        // （例如「引用的源存在吗」）能看到注入进来的那一层。
        Object.assign(file, base);
        return mutate(file);
      });
    } catch (err) {
      if (err instanceof ProviderConfigError) throw err;
      throw new Error(`写入 ${this.filePath} 失败：${errorMessage(err)}`, { cause: err });
    }
  }
}

/**
 * 把校验错误翻译成 HTTP 状态码。参数问题（字段不合法、id 冲突）是 400，
 * 找不到是 404——让调用方不必逐个 err.message 做字符串匹配。
 */
export function httpStatusForError(err: unknown): number {
  return err instanceof ProviderConfigError ? err.status : 500;
}
