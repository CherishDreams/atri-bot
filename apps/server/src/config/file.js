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

/** 配置文件名。与 loadConfig() 读取的是同一个。 */
export const CONFIG_FILE_NAME = "atri.config.json";

/** @returns {string} 配置文件绝对路径 */
export function configFilePath(root) {
  return join(root, CONFIG_FILE_NAME);
}

/**
 * 读取配置文件。
 *
 * 文件不存在返回 `{}`（首次启动、或全部配置都来自环境变量），
 * 但**解析失败必须抛错**：把坏文件当成空配置，下一次写入就会
 * 把用户丢失的配置永久覆盖掉。
 *
 * @returns {Record<string, unknown>}
 */
export function readConfigFile(root) {
  const filePath = configFilePath(root);
  if (!existsSync(filePath)) return {};

  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`无法读取配置文件 ${filePath}：${err.message}`, { cause: err });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`配置文件 ${filePath} 不是合法 JSON：${err.message}`, { cause: err });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`配置文件 ${filePath} 的顶层必须是对象`);
  }
  return parsed;
}

/** 写入配置文件，并尽量收紧权限（口令与密钥都在里面）。 */
export function writeConfigFile(root, config) {
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
 * @template T
 * @param {string} root
 * @param {(config: Record<string, unknown>) => T} mutate
 * @returns {T} mutate 的返回值
 */
export function updateConfigFile(root, mutate) {
  const config = readConfigFile(root);
  const result = mutate(config);
  writeConfigFile(root, config);
  return result;
}
