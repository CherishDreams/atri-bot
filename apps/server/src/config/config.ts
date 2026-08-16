import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_AUTH_COOKIE_NAME, DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from "@atri/shared";
import { DEFAULT_MAX_TOOL_STEPS } from "../core/tool/store.ts";
import type {
  AdapterToggle,
  FileConfig,
  ProvidersFileConfig,
  ProviderSourceEntryConfig,
  ToolToggle,
} from "./file.ts";
import { errorMessage } from "../core/errors.ts";

/**
 * `loadConfig()` 的产物：每个键都有值（内置默认 → 配置文件 → 环境变量，后者覆盖前者）。
 *
 * 这是**唯一**的完整配置类型。各模块的构造参数不要用它，而是声明自己实际读写的那几个键
 * （例如 `ProviderStoreConfig { root?: string }`）——否则测试里只传 `{ root }` 这类
 * 最小配置就过不了类型检查，而那是它们的既有前提。密钥走环境变量，结构性设置走文件。
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
  /**
   * 工具开关。**这里只是启动时的那一份快照**，运行期的读写都走
   * `core/tool/store.ts`（它在控制台改完开关后必须立刻反映新状态，见其类注释）。
   */
  tools: Record<string, ToolToggle>;
  /** 单轮工具步数上限。校验与夹取在 `ToolConfigStore.maxSteps()`，不在这里。 */
  maxToolSteps: number;
  providers: ProvidersFileConfig;
  providerSources: Record<string, ProviderSourceEntryConfig>;
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
  const filePath = join(root, "atri.config.json");

  let fileConfig: FileConfig = {};
  if (existsSync(filePath)) {
    try {
      // 边界收窄：JSON 的顶层形状在这里只由 `FileConfig` 声明，不逐键校验
      // （配置文件允许出现我们不认识的键，见 `FileConfig` 的索引签名）。
      fileConfig = JSON.parse(readFileSync(filePath, "utf8")) as FileConfig;
    } catch (err) {
      throw new Error(`解析 ${filePath} 失败: ${errorMessage(err)}`, { cause: err });
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
    // 工具与适配器相反：默认全部关闭，必须在文件里显式写 enabled: true。
    tools: fileConfig.tools ?? {},
    // 默认值取自 store 导出的那一个常量，不在这里重抄一遍数字。
    maxToolSteps: Number(
      env.ATRI_MAX_TOOL_STEPS ?? fileConfig.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS,
    ),
    // 两层 provider 配置：源（连接）与实例（模型）。测试常直接传这两个字段，
    // 因此缺省为空对象而不是 null。
    providers: fileConfig.providers ?? {},
    providerSources: fileConfig.providerSources ?? {},
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
