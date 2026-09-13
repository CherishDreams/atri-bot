import { resolve } from "node:path";
import { DEFAULT_AUTH_COOKIE_NAME, DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from "@atri/shared";
import { readConfigFile, type AdapterToggle } from "./file.ts";

/**
 * `loadConfig()` 的产物：**只有部署级参数**。每个键都有值
 * （内置默认 → `atri.config.json` → 环境变量，后者覆盖前者）。
 *
 * 这里**没有** `providers` / `providerSources` / `tools` / `maxToolSteps` —— 那是「跑法」，
 * 住在各配置档自己的 `<dataDir>/profiles/<id>/config.json` 里（见 `config/profiles.ts`），
 * 由 `ProviderConfigStore` / `ToolConfigStore` 按文件读写。删掉这几个键不是清理：
 * 只要它们还留在 `AppConfig` 上，「配置档 B 看得见 A 的 provider」就还有一条活路。
 *
 * 各模块的构造参数不要用它，而是声明自己实际读写的那几个键
 * （例如 `ProviderStoreConfig { filePath: string | null }`）——否则测试里只传
 * `{ filePath: null }` 这类最小配置就过不了类型检查，而那是它们的既有前提。
 * 密钥走环境变量，结构性设置走文件。
 */
export interface AppConfig {
  root: string;
  host: string;
  /** 实际监听端口。`start()` 之后用 `address().port` 取真实端口（`port: 0` 时由系统分配）。 */
  port: number;
  /**
   * 刻意是 `string` 而不是 `"debug" | "info" | "warn" | "error"`：
   * 未知级别今天退化为 info（见 `createLogger`），收紧成联合类型会让
   * `ATRI_LOG_LEVEL=verbose` 从「安静地按 info 跑」变成「启动失败」，那是行为变更。
   */
  logLevel: string;
  dataDir: string;
  pluginDirs: string[];
  adapters: Record<string, AdapterToggle>;
  auth: {
    adminUser: string;
    adminPassword: string | null;
    cookieName: string;
    cookieSecure: boolean;
    /**
     * 磁盘上它是**顶层键** `staticDir`，运行期却挂在 `auth` 段下（`api/server.ts` 读
     * `config.auth.staticDir`）。这个不对称是既有形状、确实这么工作着；把它「归位」到顶层
     * 会让配置文件格式与读取路径同时变，属于行为变更，迁移不动它。
     */
    staticDir: string;
  };
}

export function loadConfig(): AppConfig {
  const root = resolve(process.env.ATRI_ROOT ?? process.cwd());
  // 读法只有一处：`readConfigFile()`。以前这里自己 `existsSync` + 自己 `JSON.parse`，
  // 于是同一个文件有两套失败语义 —— 它少掉了「顶层必须是对象」那一条，所以
  // `[]` 或 `"x"` 这样的文件能顺利启动（每个键都走默认值），等到第一次界面保存时
  // 才由 `updateConfigFile` 抛出来。那是「安静地起、稍后地炸」，本仓不接受。
  const fileConfig = readConfigFile(root);

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
    auth: {
      adminUser: env.ATRI_ADMIN_USER ?? fileConfig.auth?.adminUser ?? "admin",
      // 留空表示「启动时自动生成随机口令」，由 AuthManager.init() 负责落盘。
      adminPassword: env.ATRI_ADMIN_PASSWORD ?? fileConfig.auth?.adminPassword ?? null,
      cookieName: env.ATRI_COOKIE_NAME ?? fileConfig.auth?.cookieName ?? DEFAULT_AUTH_COOKIE_NAME,
      // 默认关闭：本仓默认走明文 HTTP。前置 HTTPS 代理时用 ATRI_COOKIE_SECURE=1 打开。
      cookieSecure: env.ATRI_COOKIE_SECURE === "1" || fileConfig.auth?.cookieSecure === true,
      // 生产环境下由服务端托管控制台构建产物，并做 SPA 回退。
      staticDir: resolve(
        root,
        env.ATRI_STATIC_DIR ?? fileConfig.staticDir ?? "apps/dashboard/dist",
      ),
    },
  };
}
