import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_SERVER_PORT, DEFAULT_SERVER_HOST } from "@atri/shared";

/**
 * 配置解析顺序（后者覆盖前者）：
 *   内置默认值 -> 配置文件 -> 环境变量。
 *
 * 密钥放在环境变量里；文件用于结构性设置。
 */
export function loadConfig() {
  const root = resolve(process.env.ATRI_ROOT ?? process.cwd());
  const filePath = join(root, "atri.config.json");

  let fileConfig = {};
  if (existsSync(filePath)) {
    try {
      fileConfig = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new Error(`解析 ${filePath} 失败: ${err.message}`, { cause: err });
    }
  }

  const env = process.env;

  return {
    root,
    host: env.ATRI_HOST ?? fileConfig.host ?? DEFAULT_SERVER_HOST,
    port: Number(env.ATRI_PORT ?? fileConfig.port ?? DEFAULT_SERVER_PORT),
    logLevel: env.ATRI_LOG_LEVEL ?? fileConfig.logLevel ?? "info",
    dataDir: resolve(root, env.ATRI_DATA_DIR ?? fileConfig.dataDir ?? "data"),
    pluginDirs: (fileConfig.pluginDirs ?? ["./plugins"]).map((p) => resolve(root, p)),
    // 适配器是可选启用的；纯 agent 部署一个都不开。
    adapters: fileConfig.adapters ?? {},
    providers: fileConfig.providers ?? {},
  };
}
