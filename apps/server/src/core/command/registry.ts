/**
 * 指令注册表。
 *
 * 形状照搬 `ToolRegistry` 的两条不变量，因为「指令随插件启停」与「工具随插件启停」
 * 是同一个问题：
 * - **静态 + 动态来源**：内置指令（`register`，组合根装配期注册）与插件指令
 *   （`registerSource`，每次查询现读）。
 * - **内置优先**：插件指令撞了内置的名字或别名时不是覆盖而是让路 —— 能力授予的
 *   默认值不能被磁盘上的一段用户代码改写（工具那边由 `PluginManager` 在加载期拒绝，
 *   指令这边因为内置清单只住在组合根的注册表里，加载期不知道，所以退到运行期过滤；
 *   装配期的双重保险见 `takenNames()`，它会被注入 `PluginManager` 做加载期拒绝）。
 */
import { ApiError } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";
import type { CommandDefinition, CommandEntry } from "./types.ts";

/** 名字/别名归一：匹配不区分大小写。 */
function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 校验一条指令定义的形状。`owner` 是错误文案里的主语（「内置指令」/「插件 x」）。
 *
 * 名字与别名的判据是「非空白、1–32 字」而不是工具 id 那套小写 ASCII：
 * 指令名是用户敲的文本，不是路径组件 —— 中文别名（AstrBot 习惯）必须能注册。
 */
export function assertCommandDefinition(def: CommandDefinition, owner: string): void {
  const check = (name: string, kind: string) => {
    if (typeof name !== "string" || !/^\S{1,32}$/u.test(name.trim())) {
      throw new ApiError(`${owner}的${kind}「${String(name)}」不合法：不能含空白，长度 1–32`, 400);
    }
  };
  check(def?.name, "指令名");
  if (typeof def?.run !== "function") {
    throw new ApiError(`${owner}的指令「${def?.name}」缺少 run()`, 400);
  }
  if (typeof def?.description !== "string" || def.description.trim() === "") {
    throw new ApiError(`${owner}的指令「${def.name}」缺少 description`, 400);
  }
  for (const alias of def.aliases ?? []) check(alias, "别名");
  const names = new Set([def.name, ...(def.aliases ?? [])].map(normalize));
  if (names.size !== 1 + (def.aliases?.length ?? 0)) {
    throw new ApiError(`${owner}的指令「${def.name}」的名字与别名重复`, 400);
  }
}

export class CommandRegistry {
  #defs: CommandEntry[] = [];
  /** 归一化名字/别名 -> 静态条目。同一指令的名字与别名都指到同一个条目。 */
  #staticNames = new Map<string, CommandEntry>();
  #sources: Array<() => CommandEntry[]> = [];
  #logger: Logger;
  /** 让路警告只说一次的名字：`find`/`list` 每条消息都会现读来源，不收口就是刷屏。 */
  #warned = new Set<string>();

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  /** 动态来源里撞了内置指令的条目要过滤，且让路要让得看得见。 */
  #scanDynamic(): CommandEntry[] {
    const out: CommandEntry[] = [];
    for (const source of this.#sources) {
      for (const entry of source()) {
        const names = [entry.def.name, ...(entry.def.aliases ?? [])].map(normalize);
        if (names.some((n) => this.#staticNames.has(n))) {
          if (!this.#warned.has(entry.def.name)) {
            this.#warned.add(entry.def.name);
            // 与 takenNames() 的加载期检查是同一个判据的运行期兜底：来源可能不含
            // 插件管理器（测试、嵌入式），过滤比覆盖安全。
            this.#logger.warn(
              `指令「${entry.def.name}」（来源 ${entry.source}）与内置指令重名，已忽略`,
            );
          }
          continue;
        }
        out.push(entry);
      }
    }
    return out;
  }

  /** 注册一条内置指令（装配期）。名字或别名撞了已注册的内置指令直接抛。 */
  register(def: CommandDefinition): void {
    assertCommandDefinition(def, "内置指令");
    const entry: CommandEntry = { def, source: "builtin" };
    for (const name of [def.name, ...(def.aliases ?? [])]) {
      const key = normalize(name);
      const existing = this.#staticNames.get(key);
      if (existing) {
        throw new ApiError(
          `内置指令「${def.name}」的名字与「${existing.def.name}」冲突（${key}）`,
          400,
        );
      }
    }
    this.#defs.push(entry);
    for (const name of [def.name, ...(def.aliases ?? [])]) {
      this.#staticNames.set(normalize(name), entry);
    }
  }

  /**
   * 登记一个动态来源（插件指令）。每次查询现读：插件重载/禁用后下一条消息
   * 看到的就是新清单，不需要在每次启停时重建注册表。
   */
  registerSource(source: () => CommandEntry[]): void {
    this.#sources.push(source);
  }

  /**
   * 全部静态名字与别名（归一化后）。组合根把它注入 `PluginManager`，
   * 让「插件指令撞内置指令」在**加载期**就被拒绝并记成 failed，
   * 而不是留一个「插件显示运行中、指令却永远不响应」的静默坑。
   */
  takenNames(): Set<string> {
    return new Set(this.#staticNames.keys());
  }

  /** 按名字或别名查（不区分大小写）。静态优先；动态里撞静态的条目让路。 */
  find(name: string): CommandEntry | null {
    const key = normalize(name);
    const staticEntry = this.#staticNames.get(key);
    if (staticEntry) return staticEntry;
    return (
      this.#scanDynamic().find((entry) =>
        [entry.def.name, ...(entry.def.aliases ?? [])].map(normalize).includes(key),
      ) ?? null
    );
  }

  /** 全部指令（静态 + 动态），动态撞静态的过滤。`GET /commands` 与 `/help` 的数据源。 */
  list(): CommandEntry[] {
    const out = [...this.#defs];
    const seen = new Set(this.#defs.map((entry) => entry.def));
    for (const entry of this.#scanDynamic()) {
      if (seen.has(entry.def)) continue;
      seen.add(entry.def);
      out.push(entry);
    }
    return out;
  }
}
