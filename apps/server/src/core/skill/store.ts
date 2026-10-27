/**
 * 技能（Skill）目录：`SKILL.md` 文件夹，给 Agent 用的任务操作手册。
 *
 * 来源有两种，**发现都是文件系统扫描**：
 * - 部署级：`<dataDir>/skills/<name>/SKILL.md`，操作者放文件即安装（id = 目录名）；
 * - 插件捆绑：`<pluginDir>/skills/<name>/SKILL.md`，随插件目录分发
 *   （id = `插件目录名:技能名`，与插件本身同名段冲突时先扫到的那份生效）。
 *
 * 运行时是**渐进式披露**：启用的技能只把「名字 + 一句话说明」注入 system 报头，
 * 全文由模型按需用 `read_skill` 工具取 —— 全部塞进报头的话，几个技能就能把
 * 上下文吃满，而且绝大多数轮次根本用不到它们。
 *
 * 没有数据库、没有写入端点：技能的增删改就是文件操作（与插件同一条哲学），
 * `list()` 每次现扫，装了新技能下一次 GET 就在。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";

/** 技能**目录名**的形状（与配置档 id 同一条正则）；插件捆绑的 id 带前缀，冒号来自拼接。 */
const SKILL_DIR_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface SkillInfo {
  id: string;
  /** frontmatter 里的 name；缺省用目录名。 */
  name: string;
  /** frontmatter 里的 description。缺它这条技能不可用（目录注入没有说明就是噪音）。 */
  description: string;
  /** `skills`（部署级目录）或插件目录名。 */
  source: string;
}

/** 单个 SKILL.md 的正文上限（字符）。手册太长说明它该拆成几个技能了。 */
export const MAX_SKILL_CONTENT_CHARS = 60_000;

/**
 * 解析 SKILL.md 的 frontmatter（`---` 包围的 `key: value` 行）。
 * 不引 YAML 依赖：frontmatter 的合法子集就是扁平的 `key: value`，嵌套或列表
 * 按解析失败处理 —— 与其静默读错一个 YAML 子集，不如让作者把字段写平。
 */
export function parseFrontmatter(
  raw: string,
): { frontmatter: Record<string, string>; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const frontmatter: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    // 缩进行（嵌套写法）不是合法子集：宁可让作者把字段写平，也不静默读错。
    if (/^\s/.test(line)) return null;
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    frontmatter[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { frontmatter, body: m[2] ?? "" };
}

interface Scanned {
  id: string;
  source: string;
  filePath: string;
}

export class SkillStore {
  readonly #skillsDir: string;
  readonly #pluginDirs: readonly string[];
  readonly #logger: Logger;

  constructor({
    skillsDir,
    pluginDirs,
    logger,
  }: {
    skillsDir: string;
    pluginDirs: readonly string[];
    logger: Logger;
  }) {
    this.#skillsDir = skillsDir;
    this.#pluginDirs = pluginDirs;
    this.#logger = logger;
  }

  /** 一个根下的候选：`<root>/<name>/SKILL.md`，目录名过一遍 id 正则。 */
  #scanRoot(root: string): Scanned[] {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return []; // 目录不存在是常态（还没装任何技能）
    }
    const out: Scanned[] = [];
    for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory()) continue;
      if (!SKILL_DIR_PATTERN.test(entry.name)) {
        this.#logger.warn(`技能目录「${entry.name}」拼不出合法 id（小写字母数字与 . _ -），已跳过`);
        continue;
      }
      const filePath = join(root, entry.name, "SKILL.md");
      if (!existsSync(filePath)) continue;
      out.push({ id: entry.name, source: "", filePath });
    }
    return out;
  }

  /**
   * 全部技能（含 frontmatter），每次现扫。坏文件**跳过并 warn**而不是抛：
   * 一份手滑的 SKILL.md 不该让整张技能清单打不开。同名时部署级目录赢
   *（它排在插件目录之前），谁赢必须确定，否则重启顺序一变技能就换人。
   */
  list(): SkillInfo[] {
    return this.#listWithFiles().map(({ filePath: _filePath, ...info }) => info);
  }

  /** 内部清单：带 filePath，`read()` 用它定位文件（对外不暴露绝对路径）。 */
  #listWithFiles(): (SkillInfo & { filePath: string })[] {
    const out: (SkillInfo & { filePath: string })[] = [];
    const seen = new Set<string>();
    const roots: { root: string; source: string; id: (name: string) => string }[] = [
      { root: this.#skillsDir, source: "skills", id: (name) => name },
      ...this.#pluginDirs.map((dir) => ({
        root: join(dir, "skills"),
        source: dir.split(/[\\/]/).filter(Boolean).pop() ?? dir,
        id: (name: string) => `${dir.split(/[\\/]/).filter(Boolean).pop() ?? dir}:${name}`,
      })),
    ];
    for (const { root, source, id } of roots) {
      for (const scanned of this.#scanRoot(root)) {
        const skillId = id(scanned.id);
        if (seen.has(skillId)) continue;
        const info = this.#readFrontmatter(scanned.filePath, skillId, source);
        if (info === null) continue;
        seen.add(skillId);
        out.push(info);
      }
    }
    return out.toSorted((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** 读一条技能的全文（`read_skill` 工具与详情页用）。不存在时 `null`。 */
  read(id: string): string | null {
    const found = this.#listWithFiles().find((skill) => skill.id === id);
    if (!found) return null;
    try {
      return readFileSync(found.filePath, "utf8").slice(0, MAX_SKILL_CONTENT_CHARS);
    } catch (err) {
      this.#logger.warn(`读取技能「${id}」失败: ${errorMessage(err)}`);
      return null;
    }
  }

  #readFrontmatter(
    filePath: string,
    id: string,
    source: string,
  ): (SkillInfo & { filePath: string }) | null {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = parseFrontmatter(raw);
      if (parsed === null) {
        this.#logger.warn(`技能「${id}」的 SKILL.md 没有合法 frontmatter，已跳过`);
        return null;
      }
      return {
        id,
        name: parsed.frontmatter.name ?? id,
        description: parsed.frontmatter.description ?? "",
        source,
        filePath,
      };
    } catch (err) {
      this.#logger.warn(`读取技能「${id}」失败: ${errorMessage(err)}`);
      return null;
    }
  }
}
