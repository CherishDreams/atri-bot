/**
 * `atri.config.json` 的读写。
 *
 * 单独成文件是因为有两条写入路径——自动生成的管理员口令（AuthManager）
 * 与运行时 provider 配置（ProviderConfigStore）。两处如果各写一份
 * 「读文件 → 改键 → 写回 → chmod」，迟早会在权限位或换行符这类细节上走散。
 *
 * 所有写入都是**读-改-写**：只动调用方指定的键，配置文件里其余内容
 * （包括人写下的注释性字段、别的段落）原样保留。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../core/errors.ts";

/** 配置文件名。与 loadConfig() 读取的是同一个。 */
export const CONFIG_FILE_NAME = "atri.config.json";

/**
 * 适配器段里的单项。带索引签名是因为适配器插件可能往自己的段落里放任意配置键，
 * 读-改-写必须把它们原样带回，所以这份类型不能是封闭的。
 */
export interface AdapterToggle {
  enabled?: boolean;
  [key: string]: unknown;
}

/** provider 实例（模型）的磁盘条目。字段全可选：校验发生在写入时，不在读取时。 */
export interface ProviderEntryConfig {
  source?: string;
  model?: string;
  name?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

/** provider source（连接）的磁盘条目。同样全可选 + 开放，理由同上。 */
export interface ProviderSourceEntryConfig {
  type?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  [key: string]: unknown;
}

/**
 * provider 段：键既可以是 provider id（值是对象），也可以是保留键 `default`
 * （值是字符串）。这个「同一层混两种值类型」的形状是既有的，不是笔误。
 */
export type ProvidersFileConfig = Record<string, ProviderEntryConfig | string>;

export interface AuthFileConfig {
  adminUser?: string;
  adminPassword?: string | null;
  cookieName?: string;
  cookieSecure?: boolean;
}

/**
 * `atri.config.json` 的磁盘形状。**所有键都可选**：文件由用户手写，任何键都可能缺。
 *
 * 末尾的索引签名是刻意的：读-改-写要原样保留我们不认识的键，所以这份类型必须开放。
 * 也因此 `readConfigFile()` 只做「顶层是对象」这一条校验 ——  deeper 校验会拒绝掉
 * 我们不认识的内容，而那是配置文件允许的。
 */
export interface FileConfig {
  host?: string;
  port?: number;
  logLevel?: string;
  dataDir?: string;
  staticDir?: string;
  pluginDirs?: string[];
  adapters?: Record<string, AdapterToggle>;
  providers?: ProvidersFileConfig;
  providerSources?: Record<string, ProviderSourceEntryConfig>;
  auth?: AuthFileConfig;
  [key: string]: unknown;
}

/** @returns 配置文件绝对路径 */
export function configFilePath(root: string): string {
  return join(root, CONFIG_FILE_NAME);
}

/**
 * 读取配置文件。
 *
 * 文件不存在返回 `{}`（首次启动、或全部配置都来自环境变量），
 * 但**解析失败必须抛错**：把坏文件当成空配置，下一次写入就会
 * 把用户丢失的配置永久覆盖掉。
 */
export function readConfigFile(root: string): FileConfig {
  const filePath = configFilePath(root);
  if (!existsSync(filePath)) return {};

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`无法读取配置文件 ${filePath}：${errorMessage(err)}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`配置文件 ${filePath} 不是合法 JSON：${errorMessage(err)}`, { cause: err });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`配置文件 ${filePath} 的顶层必须是对象`);
  }
  // 这是**边界收窄**，不是糊错误：顶层是对象这一条由上面三行保证，而键的具体形状
  // 刻意不校验（FileConfig 是开放类型，见其注释）。
  return parsed as FileConfig;
}

/** 写入配置文件，并尽量收紧权限（口令与密钥都在里面）。 */
export function writeConfigFile(root: string, config: FileConfig): string {
  const filePath = configFilePath(root);
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  try {
    // Windows 等不支持 POSIX 权限的环境：忽略即可。
    chmodSync(filePath, 0o600);
  } catch {
    /* 忽略 */
  }
  return filePath;
}

/**
 * 读 → 就地改 → 写。`mutate` 抛错则完全不落盘，
 * 因此调用方可以放心地把「校验」放在里面。
 *
 * @returns mutate 的返回值
 */
export function updateConfigFile<T>(root: string, mutate: (config: FileConfig) => T): T {
  const config = readConfigFile(root);
  const result = mutate(config);
  writeConfigFile(root, config);
  return result;
}
