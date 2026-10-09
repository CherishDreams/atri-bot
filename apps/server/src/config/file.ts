/**
 * `atri.config.json` 与配置档文件的读写。
 *
 * 单独成文件是因为有多条写入路径——自动生成的管理员口令（AuthManager）、
 * 运行时 provider 配置（ProviderConfigStore）、工具开关（ToolConfigStore），
 * 以后还有每份配置档自己的 `config.json`。各处如果各写一份
 * 「读文件 → 改键 → 写回 → chmod」，迟早会在权限位或换行符这类细节上走散。
 *
 * 所有写入都是**读-改-写**：只动调用方指定的键，文件里其余内容
 * （包括人写下的注释性字段、别的段落）原样保留。
 *
 * ## 两层 API
 *
 * `*At(filePath)` 是真正干活的那一层，收的是**具体文件**；`*File(root)` 是它的
 * 一行包装，只负责「root 下的 `atri.config.json`」这一种寻址。分成两层的唯一理由
 * 是配置档不在这个 root 下（它们在 `<dataDir>/profiles/<pid>/config.json`），
 * 而**读取与校验规则必须只有一份** —— 两处各写一遍，就会有其中一处少掉某条检查
 * （`loadConfig()` 曾经就是这么漏掉「顶层必须是对象」的，见它的提交正文）。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { errorMessage } from "#core/errors.ts";

/** 配置文件名。与 loadConfig() 读取的是同一个。 */
export const CONFIG_FILE_NAME = "atri.config.json";

/**
 * 全局供应商配置的文件名（在 `dataDir` 下）。
 *
 * 为什么单独一个文件而不是回到 `atri.config.json`：那一份里躺着 `auth.adminPassword`，
 * 运行期写入者越少越好（现在只有「首次生成口令」那一条路径），而且它半截 JSON 等于
 * **整个服务起不来**；供应商配置由配置页高频读写，坏一次只该让 provider 报错。
 * 也不放仓库根：`.gitignore` 忽略的是精确名 `atri.config.json`，根下的新兄弟文件就成了
 * 「未跟踪但也不忽略」，一次 `git add -A` 就会把 `apiKey` 提交进版本库。`data/` 整目录
 * 已忽略且 0700。
 */
export const PROVIDERS_FILE_NAME = "providers.json";

/**
 * 适配器段里的单项。带索引签名是因为适配器实现可能往自己的段落里放任意配置键，
 * 读-改-写必须把它们原样带回，所以这份类型不能是封闭的。
 *
 * `profile` 是**这个接入端跑在哪份配置档上**（见 `config/profiles.ts`）。
 * 绑定为什么不搬进配置档文件：适配器是**入站**的东西，它占的资源属于部署
 *（一个监听端口、一个 webhook 回调地址、一个平台的机器人 token）；
 * 「换个平台换一套模型与工具」要搬的是它**用什么跑法**，而不是它本身。
 * 于是这里留一条指向档的引用，档那边不需要知道有没有人在用它 ——
 * 反过来的话，删一份档就得去扫所有档看谁引用了它。
 *
 * 该引用**没有默认值**：`enabled` 而没写 `profile` 的适配器不会被启动
 *（`AdapterManager.startAll` 会为此单独报一条），理由与 `?profile=` 一律必填同一条。
 */
export interface AdapterToggle {
  enabled?: boolean;
  /** 绑定到哪份配置档。必须是它的 id，且该档此刻要 `ready`。 */
  profile?: string;
  [key: string]: unknown;
}

/**
 * 工具段里的单项。形状与 `AdapterToggle` 一致（同样必须开放：读-改-写要把工具自己的
 * 配置键原样带回），但**默认语义正好相反** —— 适配器没写就是启用，工具没写就是禁用，
 * 判据分别是 `=== false` 与 `=== true`（见 `core/tool/store.ts`）。
 * 不要把两处「统一」成同一个类型或同一个判据：一边是少听一个端口，另一边是能力授予。
 */
export interface ToolToggle {
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
  tools?: Record<string, ToolToggle>;
  /**
   * 单轮允许的工具步数。**顶层键**而不是 `tools` 段里的一条：那一段的键是工具 id，
   * 放进去会和一颗真叫 `maxSteps` 的工具撞名。
   */
  maxToolSteps?: number;
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
 * 全局供应商配置的绝对路径。
 *
 * 参数是 `dataDir` 而不是 `root`：它属于**运行期数据**（与 `profiles/`、`sessions.sqlite`
 * 同级），备份 `dataDir` 就要连它一起带走；而 root 下那份 `atri.config.json` 是部署参数。
 * @returns 配置文件绝对路径
 */
export function providersFilePath(dataDir: string): string {
  return join(dataDir, PROVIDERS_FILE_NAME);
}

/**
 * 建目录并把它收到 0700，已存在时同样收紧。
 *
 * **两道都要**：`mkdir` 的 `mode` 对**已存在**的目录不起作用，也不受 `recursive`
 * 建的中间层继承；而只靠 `mkdir` 的 mode，第一次之后的每次启动就都不再设权限了。
 * `chmodSync` 在不支持 POSIX 权限的环境里会抛，忽略即可（与 `writeConfigFileAt` 同例）。
 *
 * 为什么保护要落在**目录**而不是文件：`dataDir` 下面躺着 SQLite 的 WAL 边车
 * `-wal` / `-shm`，它们由 SQLite 按 umask 创建、并在每次 checkpoint 后重建，
 * 逐文件 chmod 是一次性的假安全感；目录 0700 之后文件自身的 mode 就无关紧要了
 * （别人连 stat 都做不到）。完整理由见 `core/session/db.ts` 里的那段注释。
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* 不支持 POSIX 权限的环境：忽略 */
  }
}

/**
 * 把**已存在**的配置文件收到 0600；不存在时什么都不做 —— 这个函数绝不创造文件。
 *
 * 为什么需要多这一处：`atri.config.json` 里躺着 `auth.adminPassword`，而 seed 之后还可能有
 * 一批**已经失效但仍是明文**的 `providerSources.*.apiKey`。把运行期配置搬进配置档之后，
 * bootstrap 文件唯一的写入者只剩「首次生成口令」那一条路径 —— 于是老部署里那份 0644 的文件
 * 再也没有任何动作去收紧它（以前第一次保存 provider 配置会顺带 chmod，那是一条没人指望过的巧合）。
 * `data/` 那一侧有目录 0700 兜底（见 `ensurePrivateDir`），部署级文件没有这层兜底。
 */
export function ensurePrivateFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* 不支持 POSIX 权限的环境：忽略 */
  }
}

/**
 * 读取指定路径的配置文件。
 *
 * 文件不存在返回 `{}`（首次启动、或全部配置都来自环境变量），
 * 但**解析失败必须抛错**：把坏文件当成空配置，下一次写入就会
 * 把用户丢失的配置永久覆盖掉。
 */
export function readConfigFileAt(filePath: string): FileConfig {
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

/** 读取 root 下的 `atri.config.json`。见文件顶部的「两层 API」。 */
export function readConfigFile(root: string): FileConfig {
  return readConfigFileAt(configFilePath(root));
}

/**
 * 写入配置文件：先写**同目录**的临时文件、收紧权限，再 `renameSync` 顶替。并尽量收紧权限
 * （口令与密钥都在里面）。
 *
 * 为什么不是 `writeFileSync(filePath, …)` 一步到位：那是**截断后重写**。进程在写的中途被
 * kill、磁盘写满（ENOSPC）、掉电，留在原地的就是半截 JSON。而坏配置的既定语义是「启动即失败」
 * （见 `readConfigFileAt`），于是那半截文件把整份配置档永久锁死在 failed（所有作用域端点 503），
 * bootstrap 那一份更是让整个服务起不来 —— 而且没有 `.bak` 可回。
 * `rename` 在同一文件系统内是原子的：观察者要么看到旧的完整文件，要么看到新的完整文件。
 *
 * 临时文件必须落在同一个目录：跨文件系统的 `rename` 既不原子，POSIX 还会给 EXDEV。
 * 名字用固定的 `.tmp` 而不是带 pid 的随机后缀 —— 本进程的写全是同步的（不存在两个写者），
 * 而「一个数据目录只跑一个实例」是 README 已经写死的部署前提。
 */
export function writeConfigFileAt(filePath: string, config: FileConfig): string {
  const tmpPath = `${filePath}.tmp`;
  try {
    // `mode` 只在**创建**时生效；随后的 rename 换掉的是目录项，所以最终文件的权限就是这一份。
    // 顺带得到一个期望之外的副作用：一个历史上 0644 的配置文件，在被写过一次之后就是 0600 了。
    writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      // Windows 等不支持 POSIX 权限的环境：忽略即可。
      chmodSync(tmpPath, 0o600);
    } catch {
      /* 忽略 */
    }
    renameSync(tmpPath, filePath);
  } catch (err) {
    // 失败的残留要清，但清不掉绝不能把原始失败盖过去 —— 所以内层整个忽略。
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* 忽略：真正的原因在 cause 里 */
    }
    throw new Error(`写入 ${filePath} 失败：${errorMessage(err)}`, { cause: err });
  }
  return filePath;
}

/** 写入 root 下的 `atri.config.json`。 */
export function writeConfigFile(root: string, config: FileConfig): string {
  return writeConfigFileAt(configFilePath(root), config);
}

/**
 * 读 → 就地改 → 写。`mutate` 抛错则完全不落盘，
 * 因此调用方可以放心地把「校验」放在里面。
 *
 * **中间永远不许出现 `await`**：`node:fs` 的同步调用让「读—改—写」在单线程里
 * 是一段不可打断的序列，于是同一个文件上有多个写入者（配置档文件上就同时躺着
 * provider 段与 tools 段）也不会交错。一旦把它改成异步，两个写入者就会各读各写、
 * 后者把前者的段落整个抹掉 —— 而那是一句 `201` 之后的静默数据丢失。
 *
 * @returns mutate 的返回值
 */
export function updateConfigFileAt<T>(filePath: string, mutate: (config: FileConfig) => T): T {
  const config = readConfigFileAt(filePath);
  const result = mutate(config);
  writeConfigFileAt(filePath, config);
  return result;
}

/** 读-改-写 root 下的 `atri.config.json`。 */
export function updateConfigFile<T>(root: string, mutate: (config: FileConfig) => T): T {
  return updateConfigFileAt(configFilePath(root), mutate);
}
