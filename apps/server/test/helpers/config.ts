import { join } from "node:path";
import { DEFAULT_AUTH_COOKIE_NAME } from "@atri/shared";
import type { AppConfig } from "../../src/config/index.ts";

/**
 * 起 app 用的 config 工厂。
 *
 * 存在的理由只有一个：迁移前 6 个测试文件各自手写过一份**几乎相同**的完整 config
 * （只在 `providers` / `staticDir` / 口令三个字段上有差别），而迁到 TS 之后
 * `AppConfig` 的必填键要求它们逐字补全 —— 与其抄 6 遍，不如收成一处。
 *
 * 三条刻意的约束：
 * 1. **默认值取自 `loadConfig()` 的内置默认**，但不做 `resolve()`：测试要的是
 *    每个字段的值可预测，而不是「相对 cwd 展开」这种看不见的行为。
 * 2. `staticDir` 默认指向一个**不存在**的目录（沿用迁移前多数测试的写法），
 *    这样静态托管天然走 404 分支，不会意外读到仓库里的 `apps/dashboard/dist`。
 * 3. 这里不替任何测试补「它今天没有生效」的键 —— 需要别的行为就显式传参，
 *    让差异留在 diff 里可看。
 */
export interface TestConfigInput {
  /** 临时根目录。provider 配置的落盘位置与 `dataDir` 都从它算出来。 */
  root: string;
  providers?: AppConfig["providers"];
  providerSources?: AppConfig["providerSources"];
  pluginDirs?: string[];
  adapters?: AppConfig["adapters"];
  /** 工具开关。默认空 = 全部禁用（工具是能力授予，默认关闭）。 */
  tools?: AppConfig["tools"];
  /** 覆盖 `auth` 段里的任意键（如测试要验证 `cookieSecure` 开关）。 */
  auth?: Partial<AppConfig["auth"]>;
  /** 默认指向不存在的目录；要测静态托管/SPA 回退时传真实目录。 */
  staticDir?: string;
  /** 默认口令；某些测试要自己读回生成的口令时传 null。 */
  adminPassword?: string | null;
  dataDir?: string;
}

export function makeTestConfig({
  root,
  providers = {},
  providerSources = {},
  pluginDirs = [],
  adapters = {},
  tools = {},
  auth = {},
  staticDir = join(root, "nonexistent"),
  adminPassword = "pw",
  dataDir = join(root, "data"),
}: TestConfigInput): AppConfig {
  return {
    root,
    host: "127.0.0.1",
    port: 0, // 随机端口，避免测试之间抢端口
    logLevel: "error",
    dataDir,
    pluginDirs,
    adapters,
    tools,
    providers,
    providerSources,
    auth: {
      adminUser: "admin",
      adminPassword,
      cookieName: DEFAULT_AUTH_COOKIE_NAME,
      cookieSecure: false,
      staticDir,
      ...auth,
    },
  };
}
