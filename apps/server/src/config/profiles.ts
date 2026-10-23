/**
 * 配置档（profile）的文件层。
 *
 * 一份配置档 = 一套「跑法」：开哪些工具、单轮最多几步、开哪些插件，以及默认用全局
 * 供应商清单里的哪一个模型。
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
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterAccessControl } from "@atri/shared";
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
 * 第一次落盘时用的那个 id。定义在 `@atri/shared`（dashboard 补 `?profile=` 时要用同一个值，
 * 两处各写一份字面量的话，改 seed 落点只会得到「前端不再优先选它」这种没有报错的症状）。
 *
 * **服务端仍然不给它任何运行期特权**：缺 `?profile=` 一律 400（见 `api/server.ts` 的
 * `scopedProfile`），绝不回落到这一份。优先选它的只有前端的路由守卫，而且是在**URL 里写明**
 * 之后才发请求 —— 那与「服务端猜」是两件事，分别由 `openapi-request.test.ts` 与
 * `router/index.ts` 守着。
 */
export { DEFAULT_PROFILE_ID } from "@atri/shared";

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
  /**
   * 这一档默认用哪个 provider **实例**。存实例 id 而不是模型名：实例 id 才是
   * `ProviderRegistry.#resolveFor` 的第一级判据，而模型名不再跨档唯一。
   *
   * 它存在的理由是「供应商与模型清单已经是全局的，但每一档要能用其中不同的那一个」。
   * 没写这一项时回落到全局 `providers.default`，两级都不是靠猜 —— 见 `app.ts` 的装配。
   */
  defaultProvider?: string;
  /** 这一档选用的人格 id；缺省表示不注入人格提示。人格本体在 `personas.json`。 */
  personaId?: string;
  /**
   * 下面两段属于**旧形状**：供应商配置现在住在 `providers.json` 里（全局一份）。
   * 保留是为了读得懂升级前留下的文件，并由 `migrateProvidersToGlobal` 搬出去一次。
   */
  providers?: ProvidersFileConfig;
  providerSources?: Record<string, ProviderSourceEntryConfig>;
  tools?: Record<string, ToolToggle>;
  maxToolSteps?: number;
  /** 每份配置档自己的插件启用清单。装是全局的，这里只决定开不开。 */
  plugins?: Record<string, PluginToggle>;
  /**
   * 这一档的准入控制。绑定到这一档的适配器共用它；换一档就是另一张名单。
   * 它不再是适配器实例的属性 —— 平台实例只是这份跑法的入口。
   */
  access?: AdapterAccessControl;
  [key: string]: unknown;
}

/** 一份没有配置过准入的档：全部放行。每次返回新对象，避免调用方误改共享值。 */
export function emptyAccess(): AdapterAccessControl {
  return { whitelistEnabled: false, allowedIds: [], adminIds: [] };
}

function normalizeAccessIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (id === "" || /\s/.test(id) || id.length > 128 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * 读盘时的归一：**形状坏掉时 fail-closed**。
 *
 * 以前这里把坏形状退化成「白名单关闭」，于是一个 `"whitelistEnabled": "true"` 的
 * 手写笔误就把机器人对所有人开放，而且没有任何提示。现在缺少 `access` 键仍表示
 * 「没配过、默认放行」，但只要键存在而形状不对，就只保留可解析的管理员 id、
 * 其余一律拒绝，由调用方记一条 warn；操作者修好文件（或重新保存一次）即可恢复。
 */
export function normalizeAccess(raw: unknown, onMalformed?: () => void): AdapterAccessControl {
  if (raw === undefined) return emptyAccess();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    onMalformed?.();
    return { whitelistEnabled: true, allowedIds: [], adminIds: [] };
  }
  const record = raw as Record<string, unknown>;
  const adminIds = normalizeAccessIds(record.adminIds);
  const allowedIds = normalizeAccessIds(record.allowedIds);
  const whitelistEnabled = record.whitelistEnabled === true;
  const valid =
    typeof record.whitelistEnabled === "boolean" &&
    Array.isArray(record.allowedIds) &&
    Array.isArray(record.adminIds) &&
    record.allowedIds.every((item) => typeof item === "string") &&
    record.adminIds.every((item) => typeof item === "string");
  if (!valid) {
    onMalformed?.();
    return { whitelistEnabled: true, allowedIds: [], adminIds };
  }
  return {
    whitelistEnabled,
    allowedIds,
    adminIds,
  };
}

/** API 写入时的严格校验：形状不对直接 400，不静默丢条目。 */
export function validateAccess(raw: unknown): AdapterAccessControl {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("access 必须是对象", 400);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.whitelistEnabled !== "boolean") {
    throw new ApiError("access.whitelistEnabled 必须是布尔值", 400);
  }
  for (const key of ["allowedIds", "adminIds"] as const) {
    const value = record[key];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new ApiError(`access.${key} 必须是字符串数组`, 400);
    }
    for (const item of value) {
      const id = item.trim();
      if (id === "" || /\s/.test(id)) {
        throw new ApiError(`access.${key} 里的 id 不能为空或包含空白`, 400);
      }
      if (id.length > 128) throw new ApiError(`access.${key} 里的 id 太长（最多 128）`, 400);
    }
  }
  return {
    whitelistEnabled: record.whitelistEnabled,
    allowedIds: normalizeAccessIds(record.allowedIds),
    adminIds: normalizeAccessIds(record.adminIds),
  };
}

/**
 * 配置档文件里属于「旧形状里已经全局化」的那两段。与 `RUN_SHAPE_KEYS`（bootstrap 侧的
 * 同一批死键）同一条用途：搬完之后每次启动按档提醒，而不是让第二个真源安静地留在磁盘上。
 */
export const PROVIDER_SHAPE_KEYS = ["providers", "providerSources"] as const;

/** 这一档文件里还留着哪些已经全局化的段（返回键名；空数组表示干净）。 */
export function providerShapeKeysIn(profile: ProfileFileConfig): string[] {
  return PROVIDER_SHAPE_KEYS.filter((key) => profile[key] !== undefined);
}

/** `migrateProvidersToGlobal` 的产物，只用于日志（不参与任何运行期判定）。 */
export interface ProvidersMigration {
  /**
   * 这次合并的内容是从哪儿来的：
   *
   * - `"profiles"`：各配置档文件里有那两段（上一版的形状），逐档合并。
   * - `"bootstrap"`：一份配置档里都没有，而 `atri.config.json` 有 —— 那是**最初的安装**
   *   （bootstrap 是唯一写过它们的地方）。不取这一支的话，新部署拿不到自己配好的模型，
   *   而取的那一步发生在 seed 之前，老部署永远走不到它。
   */
  from: "profiles" | "bootstrap";
  /** 合并进全局文件的 source id。 */
  sources: string[];
  /** 合并进全局文件的 provider 实例 id。 */
  providers: string[];
  /** 被丢弃的项：`"来源档 id → 键名"`，两个档配了同一个 source 时只有一个能赢。 */
  dropped: string[];
  /** 文件里仍留着那两段的配置档（框架从不删用户的文件）。 */
  leftovers: string[];
}

/**
 * 把散在各份配置档里的供应商配置合并成全局的 `providers.json`。**一次性**：
 * 目标文件已存在就什么都不做（与 `seedProfile` 同一条幂等判据 —— 用「目标在不在」而不是版本号，
 * 版本号会诱使有人加第二个真源来记「搬过没有」）。
 *
 * 冲突取**字典序最小的那份档**：`listProfileDirs` 已经排序，所以这个赢家是确定的，
 * 换台机器、重启多少次都不会变；其余的进 `dropped` 由调用方 warn 说清。
 * 「谁赢」这件事必须有明确规则 —— 让它随启动顺序漂移，症状就是某天模型悄悄换了。
 *
 * **不删**各档文件里的那两段（框架从不删用户写的东西），只回报谁还留着，
 * 由装配处每次启动 warn 一次。
 *
 * @returns 合并报告；`null` 表示全局文件已经存在，这次什么都没做。
 */
export function migrateProvidersToGlobal(
  profilesDir: string,
  targetPath: string,
  bootstrap: FileConfig,
): ProvidersMigration | null {
  if (existsSync(targetPath)) return null;

  const sources: Record<string, unknown> = {};
  const providers: Record<string, unknown> = {};
  const dropped: string[] = [];
  const leftovers: string[] = [];
  /** 有档**写过**这两段即为真源，即使值是空对象；是否非空由后面的 from 判据区分。 */
  let sawProviderShape = false;

  for (const id of listProfileDirs(profilesDir)) {
    let profile: ProfileFileConfig;
    try {
      profile = readProfileConfig(profileConfigPath(profilesDir, id));
    } catch (err) {
      // 读不出来的那一档不参与合并，也**不能**让整次迁移失败：它的文件坏了是它自己的事
      //（`openProfile` 那边会登记成 failed），这里跟着坏掉只会让整个服务起不来。
      dropped.push(`${id} → 文件读不出（${err instanceof Error ? err.message : String(err)}）`);
      continue;
    }
    if (providerShapeKeysIn(profile).length > 0) {
      leftovers.push(id);
      sawProviderShape = true;
    }

    for (const [key, value] of Object.entries(profile.providerSources ?? {})) {
      if (key in sources) {
        dropped.push(`${id} → source「${key}」已被更早的一份档占用`);
        continue;
      }
      sources[key] = value;
    }
    // `default` 这个保留键按普通键一起合并：第一个非空的就是赢家，规则与上面同一条。
    for (const [key, value] of Object.entries(profile.providers ?? {})) {
      if (key in providers) {
        dropped.push(`${id} → provider「${key}」已被更早的一份档占用`);
        continue;
      }
      providers[key] = value;
    }
  }

  let from: ProvidersMigration["from"] = "profiles";
  if (!sawProviderShape) {
    // **所有档都没有出现过这两段**：那是最初的安装，bootstrap 才是唯一写过它们的地方。
    // 判据是「有没有出现过键」而不是「合并结果是否非空」—— 一份写着 `"providers": {}`
    // 的档是操作者明确清空过的真源，不能因为它是空对象就从 bootstrap 把死键复活回来。
    from = "bootstrap";
    Object.assign(sources, bootstrap.providerSources ?? {});
    Object.assign(providers, bootstrap.providers ?? {});
  }

  // 两边都空也要写：写下去之后「文件在不在」才是那个可靠的「搬过没有」信号。
  // 不写的话每次启动都要重扫一遍所有档，而用户也看不出这份空文件是不是坏了。
  writeConfigFileAt(targetPath, {
    providerSources: sources,
    providers,
  } as FileConfig);

  return {
    from,
    sources: Object.keys(sources),
    providers: Object.keys(providers).filter((key) => key !== "default"),
    dropped,
    leftovers,
  };
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
 * 删掉一份配置档的**整个目录**：`config.json` 与它自己的 `plugins/<插件 id>/` 数据。
 *
 * 为什么不只删 `config.json`：目录里剩下的插件数据再也没有主人 —— 下次新建同名档时，
 * 它会把上一个档的插件数据当成自己的。删除是操作者的明确动作，`DELETE /profiles/{id}`
 * 的语义就是「这一份从这里消失」。
 *
 * 路径只由 `profileDir()` 拼，而它先过 `PROFILE_ID_PATTERN`（`.`、`..`、斜杠都进不来）——
 * 这是本仓唯一一个 recursive 删除，绝不能让调用方把未校验的字符串递进来。
 *
 * 调用方必须先把它从服务里摘掉再调用：摘除失败（例如还被一次对话占着）时一个字节都不该动。
 */
export function removeProfileDir(profilesDir: string, id: string): void {
  rmSync(profileDir(profilesDir, id), { recursive: true, force: true });
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
 * 现在只搬 `tools` 与 `maxToolSteps`。**供应商不在其中**：它是部署级全局的一份，
 * 落在 `providers.json`（由 `migrateProvidersToGlobal` 从 bootstrap 或各档里取一次）。
 * 被否掉的做法是「照旧抄进配置档、再由合并搬出去」：那会让每次全新安装都由**我们自己**
 * 在档文件里写出一个残留段，然后每次启动 warn 一句「你文件里有一段不再生效」。
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
