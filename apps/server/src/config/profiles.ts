/**
 * 配置档（profile）的文件层。
 *
 * 一份配置档 = 一套「跑法」：用哪些 provider、开哪些工具、单轮最多几步、开哪些插件。
 * 它住在 `<dataDir>/profiles/<id>/config.json`，**一个配置档一个目录**而不是
 * `<id>.json`：它自己的插件数据（`plugins/<插件 id>/`）就躺在同一个 0700 子树下，
 * 而 `readdir` 也不必在「这是文件还是目录」上分叉。
 *
 * 为什么在 `data/` 下面而不是仓库根的 `configs/`：`.gitignore` 忽略的是**精确名**
 * `atri.config.json`，把带 apiKey 的兄弟文件放进仓库根就是「未跟踪但也不忽略」——
 * 一次顺手 `git add -A` 会把所有配置档的密钥提交进版本库。`data/` 整体被忽略，
 * 而且已经是 0700（保护落在目录上，理由见 `ensurePrivateDir`）。
 *
 * 本模块只做文件：不认识 `AppConfig`，不构造任何存储，也不决定「哪个请求用哪一份」。
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ApiError } from "#core/errors.ts";
import {
  ensurePrivateDir,
  readConfigFileAt,
  updateConfigFileAt,
  writeConfigFileAt,
  type FileConfig,
  type ProvidersFileConfig,
  type ProviderSourceEntryConfig,
  type ToolToggle,
} from "./file.ts";

/** 配置档们的根目录名（在 `dataDir` 下）。 */
export const PROFILES_DIR_NAME = "profiles";
/** 一个配置档目录里那份运行期配方的文件名。 */
export const PROFILE_FILE_NAME = "config.json";
/**
 * 第一次落盘时用的那个 id。
 *
 * **它没有任何运行期特权** —— 不是「默认回落的那一份」，也不是「不可删的那一份」。
 * 它今天唯一的用处是 `seedProfile()` 的落点；运行期选中哪一份由请求决定（下一阶段）。
 */
export const DEFAULT_PROFILE_ID = "default";

/**
 * 能当目录名用的配置档 id。
 *
 * 首字符必须是字母或数字（于是 `.` 与 `..` 天然进不来），其余允许 `. _ -`，长度 1–64，
 * **只允许小写**。小写这一条不是审美：大小写敏感的机器上 `Work` 与 `work` 是两个目录，
 * 而 Windows / macOS 默认文件系统会把它们合成一个 —— 同一份配置被两个 id 写。
 */
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * 「跑法」里那些段的名字：`seedProfile()` 搬的就是这几段，
 * 而「bootstrap 里是否还留着运行期配置」也按这一份清单回答。
 */
export const RUN_SHAPE_KEYS = ["providers", "providerSources", "tools", "maxToolSteps"] as const;

/** 插件段里的单项。形状与 `AdapterToggle` / `ToolToggle` 一致（同样必须开放）。 */
export interface PluginToggle {
  enabled?: boolean;
  [key: string]: unknown;
}

/**
 * `<profiles>/<id>/config.json` 的磁盘形状。所有键可选，且带索引签名
 * （读-改-写要原样保留我们不认识的键，理由与 `FileConfig` 同一条）。
 *
 * 刻意**不**复用 `FileConfig`：那一份的必填项是部署级参数（`host` / `port` / `auth`），
 * 复制过来就等于邀请有人真的往配置档里写端口 —— 而那是整个进程共享的。
 */
export interface ProfileFileConfig {
  /** 给人看的名字；缺省时界面直接用 id。 */
  name?: string;
  providers?: ProvidersFileConfig;
  providerSources?: Record<string, ProviderSourceEntryConfig>;
  tools?: Record<string, ToolToggle>;
  maxToolSteps?: number;
  /** 每份配置档自己的插件启用清单。装是全局的，这里只决定开不开。 */
  plugins?: Record<string, PluginToggle>;
  [key: string]: unknown;
}

/** 配置档们的根目录（由 `dataDir` 算出）。 */
export function profilesRoot(dataDir: string): string {
  return join(dataDir, PROFILES_DIR_NAME);
}

/**
 * id 能不能当目录名用；不能就说清是哪一条约束没满足。
 *
 * 抛 `ApiError(..., 400)`：这条校验的两个出口（HTTP 建配置档、路径拼接前的最后一道闸）
 * 想要的形状不同，而规则只有一份 —— 与 `assertPluginDirName` 同一条设计。
 */
export function assertProfileId(id: unknown): string {
  if (typeof id !== "string" || !PROFILE_ID_PATTERN.test(id)) {
    throw new ApiError(
      `配置档 id「${String(id)}」不合法：只允许小写字母、数字与 . _ -，` +
        `首字符必须是字母或数字，长度 1–64`,
      400,
    );
  }
  return id;
}

/** `<profiles>/<id>` 目录。id 不合法直接抛，不给 `join` 拼出穿越路径的机会。 */
export function profileDir(profilesDir: string, id: string): string {
  return join(profilesDir, assertProfileId(id));
}

/** `<profiles>/<id>/config.json`。 */
export function profileConfigPath(profilesDir: string, id: string): string {
  return join(profileDir(profilesDir, id), PROFILE_FILE_NAME);
}

/**
 * 列出配置档 id（按名字排序）。
 *
 * 只认**目录**：一个孤零零的文件躺在 `profiles/` 下不是配置档，忽略它而不是让整份
 * 清单读不出来。目录读不到（权限、竞态删除）也只跳过这一颗 —— 一颗坏了不拖垮别人，
 * 与 `PluginManager.#scanDir` 的逐条 try/catch 同一条规矩。
 */
export function listProfileDirs(profilesDir: string): string[] {
  let entries;
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    // 目录还不存在（首次启动、或 dataDir 刚被换掉）：一份配置档都没有，不是错误。
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && PROFILE_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .toSorted();
}

/**
 * 读一份配置档。失败语义与 `readConfigFileAt` 完全一致（不存在 → `{}`；坏 → 抛）。
 *
 * 抛出去的那句里带着**绝对路径**，所以它只能进日志或 `failed` 记录的操作者字段，
 * 不能直接从 HTTP 响应体里发出去（同 `ProviderConfigStore.#write` 的那条纪律）。
 */
export function readProfileConfig(filePath: string): ProfileFileConfig {
  // 边界收窄：顶层是对象这一条由 `readConfigFileAt` 保证，键的具体形状刻意不校验
  //（配置档文件允许出现我们不认识的键，与 `FileConfig` 同一条理由）。
  return readConfigFileAt(filePath) as ProfileFileConfig;
}

/**
 * 写一份配置档。目录（`<profiles>/<id>`）顺带建出来并收到 0700 ——
 * 配方与它自己的插件数据在同一个保护伞下，所以这道不能省。
 *
 * @returns 写入的文件路径
 */
export function writeProfileConfig(filePath: string, config: ProfileFileConfig): string {
  ensurePrivateDir(dirname(filePath));
  return writeConfigFileAt(filePath, config);
}

/** bootstrap 里还留着哪些「跑法」段（返回键名；空数组表示干净）。 */
export function runShapeKeysIn(bootstrap: FileConfig): string[] {
  return RUN_SHAPE_KEYS.filter((key) => bootstrap[key] !== undefined);
}

/**
 * 读 → 就地改 → 写**一份配置档**。
 *
 * 走的是 `updateConfigFileAt` 那同一个实现，所以「mutate 抛错就完全不落盘」与
 * 「读-改-写保留我们不认识的键」这两条性质自动继承，不需要在配置档这一层再写一遍。
 */
export function updateProfileConfig<T>(
  filePath: string,
  mutate: (config: ProfileFileConfig) => T,
): T {
  return updateConfigFileAt(filePath, (file) =>
    // 边界收窄：`readConfigFileAt` 已经保证顶层是非 null 的非数组对象，
    // 而 `FileConfig` 与 `ProfileFileConfig` 都是**开放**类型（带索引签名），
    // 两者的差异只在「哪些键有名」，不在「能不能多键」。
    mutate(file as ProfileFileConfig),
  );
}

/**
 * 把某个插件在这份配置档里的启用状态写回文件。
 *
 * 由 `PluginManager` 经构造参数调用（`PluginStorage.persistEnabled`），
 * 所以 `plugins/` 层不需要认识这个文件；写失败会一路抛回 HTTP 层，
 * 管理器**先落盘再动内存**正是为了让那种失败留下一个自洽的状态。
 */
export function setProfilePluginEnabled(
  filePath: string,
  pluginId: string,
  enabled: boolean,
): void {
  updateProfileConfig(filePath, (config) => {
    const plugins = config.plugins ?? {};
    // 展开保留段落里我们不认识的键（`PluginToggle` 是开放类型，与工具/适配器同一条理由）。
    plugins[pluginId] = { ...plugins[pluginId], enabled };
    config.plugins = plugins;
  });
}

/**
 * 一次性把 bootstrap（`atri.config.json`）里的「跑法」搬进配置档文件。
 *
 * **幂等**：目标文件已存在就一个字都不动，返回 `null` —— bootstrap 里那几段自此不再是
 * 真源，否则同一份设置会有两个写入点，而「改了没生效」会以最难查的形态出现。
 * 目标不存在时**总是创建**，即使 bootstrap 里什么都没有：这样「至少有一份配置档」
 * 是启动的不变量，控制台的列表在新部署上不会空着。
 *
 * 调用方（组合根）负责两件事：先建好 `profilesDir`，以及在本函数返回 `null` 之后
 * **不再**读 bootstrap 里那几段。
 *
 * @returns 搬过去的键名（可能是空数组）；目标文件本来就在则 `null`
 */
export function seedProfile(
  profilesDir: string,
  id: string,
  bootstrap: FileConfig,
): string[] | null {
  const filePath = profileConfigPath(profilesDir, id);
  if (existsSync(filePath)) return null;

  const profile: ProfileFileConfig = {};
  const moved: string[] = [];
  if (bootstrap.providers !== undefined) {
    profile.providers = bootstrap.providers;
    moved.push("providers");
  }
  if (bootstrap.providerSources !== undefined) {
    profile.providerSources = bootstrap.providerSources;
    moved.push("providerSources");
  }
  if (bootstrap.tools !== undefined) {
    profile.tools = bootstrap.tools;
    moved.push("tools");
  }
  if (bootstrap.maxToolSteps !== undefined) {
    profile.maxToolSteps = bootstrap.maxToolSteps;
    moved.push("maxToolSteps");
  }
  writeProfileConfig(filePath, profile);
  return moved;
}
