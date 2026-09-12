import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_AUTH_COOKIE_NAME } from "@atri/shared";
import type { AppConfig } from "#config/index.ts";
import { configFilePath, readConfigFileAt, writeConfigFileAt } from "#config/file.ts";
// 默认值从 store 取，不在测试里重抄一遍数字：否则「代码默认 5、测试默认 6」这种漂移
// 会让用例证的不再是生产行为。
import { DEFAULT_MAX_TOOL_STEPS } from "#core/tool/store.ts";

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
 *
 * 第四条是随着「存储按 `filePath` 寻址」加进来的：**`providers` / `providerSources` /
 * `tools` / 非默认的 `maxToolSteps` 会真的写进 `<root>/atri.config.json`**。
 * 因为那两个存储现在的规则是「给了 `filePath`，那个文件就是唯一真相」，注入的
 * baseline 只在 `filePath: null` 时生效 —— 测试想「启动时就有这些 provider」，
 * 就得让它们躺在文件里，这才是生产的那条路径。仍然**只写非默认的那几键**：
 * 全写会让每一个测试都凭空多出一配置文件，而「文件不存在」本身是要被某些用例覆盖的状态。
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
  /** 默认 5；测试要证「撞上限」这类行为时显式传，别改默认值。 */
  maxToolSteps?: number;
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
  maxToolSteps = DEFAULT_MAX_TOOL_STEPS,
  auth = {},
  staticDir = join(root, "nonexistent"),
  adminPassword = "pw",
  dataDir = join(root, "data"),
}: TestConfigInput): AppConfig {
  // 见文件头第四条：结构性配置的真源是文件，所以把这些键落盘，而不是指望注入值生效。
  //
  // 这里是**读-改-写**，且**不覆盖文件里已经写过的键**：有些测试（`tool-stream.test.ts`、
  // `provider-routes.test.ts`）在调本函数之前就把自己的场景预置进了那个文件，
  // 覆盖过去等于替测试改掉它要验的前提。
  const filePath = configFilePath(root);
  const file = readConfigFileAt(filePath);
  let changed = false;
  if (Object.keys(providers).length > 0 && !Object.hasOwn(file, "providers")) {
    file.providers = providers;
    changed = true;
  }
  if (Object.keys(providerSources).length > 0 && !Object.hasOwn(file, "providerSources")) {
    file.providerSources = providerSources;
    changed = true;
  }
  if (Object.keys(tools).length > 0 && !Object.hasOwn(file, "tools")) {
    file.tools = tools;
    changed = true;
  }
  if (maxToolSteps !== DEFAULT_MAX_TOOL_STEPS && !Object.hasOwn(file, "maxToolSteps")) {
    file.maxToolSteps = maxToolSteps;
    changed = true;
  }
  if (changed) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeConfigFileAt(filePath, file);
  }

  return {
    root,
    host: "127.0.0.1",
    port: 0, // 随机端口，避免测试之间抢端口
    logLevel: "error",
    dataDir,
    pluginDirs,
    adapters,
    tools,
    maxToolSteps,
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
