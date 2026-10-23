import { ApiError, errorMessage } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";
import { readConfigFileAt, writeConfigFileAt } from "#config/file.ts";
import type { PersonaInfo } from "@atri/shared";

/**
 * 人格库：全局一份，落盘在 `<dataDir>/personas.json`。
 *
 * 与供应商同一条归属判据：人格是**可复用的内容资产**，不是某个配置档的运行参数。
 * 一份人格可能被多份档选用，按档各存一份会让同一个人格出现多个会漂移的副本；
 * 配置档里只留一根 `personaId` 引用。
 */

const PERSONA_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const DEFAULT_PERSONA_ID = "default";

const DEFAULT_PERSONA: PersonaInfo = {
  id: DEFAULT_PERSONA_ID,
  name: "默认人格",
  description: "atri-bot 的基础助手设定；可以直接编辑它，也可以新建更多人格。",
  systemPrompt: "你是 atri-bot，一个中文 AI 助手。回答自然、简洁，不要假装拥有未提供的能力。",
};

interface PersonasFile {
  personas?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPersonaId(value: string): string {
  if (!PERSONA_ID_PATTERN.test(value)) {
    throw new ApiError(
      `人格 id「${value}」不合法：只允许小写字母、数字与 . _ -，首字符必须是字母或数字，长度 1–64`,
      400,
    );
  }
  return value;
}

function normalizePersona(value: unknown): PersonaInfo | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  if (!PERSONA_ID_PATTERN.test(id)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const systemPrompt = typeof value.systemPrompt === "string" ? value.systemPrompt : "";
  if (name === "") return null;
  return { id, name, description, systemPrompt };
}

function validateInput(input: unknown): Omit<PersonaInfo, "id"> {
  if (!isRecord(input)) throw new ApiError("人格内容必须是对象", 400);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const systemPrompt = typeof input.systemPrompt === "string" ? input.systemPrompt : "";
  if (name === "") throw new ApiError("人格名称不能为空", 400);
  if (name.length > 80) throw new ApiError("人格名称最多 80 个字符", 400);
  if (systemPrompt.trim() === "") throw new ApiError("人格提示词不能为空", 400);
  return { name, description, systemPrompt };
}

/**
 * 读写人格文件。所有方法同步：这是小文件，缓存反而会多一份要维护的真源。
 *
 * 文件坏掉不让服务起不来（与适配器配置同一判断），但会保留一句 error 日志；
 * 下一次成功写入会以内存里的空表重建文件 —— 这与「把手改坏的文件当成空配置」
 * 同样危险，因此读取失败时所有写入都会被拒绝，直到文件修好。
 */
export class PersonaStore {
  #filePath: string;
  #logger: Logger;
  #broken = false;
  #personas = new Map<string, PersonaInfo>();

  constructor({ filePath, logger }: { filePath: string; logger: Logger }) {
    this.#filePath = filePath;
    this.#logger = logger;
    this.#load();
  }

  get filePath(): string {
    return this.#filePath;
  }

  list(): PersonaInfo[] {
    return [...this.#personas.values()].toSorted((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): PersonaInfo | null {
    const found = this.#personas.get(id);
    return found === undefined ? null : { ...found };
  }

  /** 配置档引用的人格提示；`null` / 不存在都返回空串（不阻断消息）。 */
  promptFor(id: string | null): string {
    if (id === null) return "";
    return this.#personas.get(id)?.systemPrompt ?? "";
  }

  create(input: unknown): PersonaInfo {
    if (!isRecord(input)) throw new ApiError("人格内容必须是对象", 400);
    const id = assertPersonaId(typeof input.id === "string" ? input.id.trim() : "");
    if (this.#personas.has(id)) throw new ApiError(`人格「${id}」已经存在`, 409);
    const fields = validateInput(input);
    const persona: PersonaInfo = { id, ...fields };
    const next = new Map(this.#personas);
    next.set(id, persona);
    // 先落盘、再换内存：失败时 GET /personas 不能出现一条从未保存成功的人格。
    this.#persistPersonas(next);
    this.#personas = next;
    return { ...persona };
  }

  update(id: string, input: unknown): PersonaInfo {
    const current = this.#personas.get(id);
    if (current === undefined) throw new ApiError(`未知人格: ${id}`, 404);
    const fields = validateInput(input);
    const persona: PersonaInfo = { id, ...fields };
    const next = new Map(this.#personas);
    next.set(id, persona);
    this.#persistPersonas(next);
    this.#personas = next;
    return { ...persona };
  }

  remove(id: string): boolean {
    if (!this.#personas.has(id)) return false;
    const next = new Map(this.#personas);
    next.delete(id);
    this.#persistPersonas(next);
    this.#personas = next;
    return true;
  }

  #load(): void {
    let file: PersonasFile;
    try {
      file = readConfigFileAt(this.#filePath);
    } catch (err) {
      this.#broken = true;
      this.#logger.error(
        `读取人格库失败，人格暂时为空（修好文件前不会写入）：${errorMessage(err)}`,
      );
      return;
    }

    if (!Object.hasOwn(file, "personas")) {
      // 第一次启动：给一个可编辑的默认人格，而不是让页面空白。
      this.#personas.set(DEFAULT_PERSONA.id, { ...DEFAULT_PERSONA });
      try {
        this.#persistPersonas(this.#personas);
      } catch (err) {
        this.#logger.warn(`初始化人格库失败（本次仍按内存中的默认人格运行）：${errorMessage(err)}`);
      }
      return;
    }

    if (!Array.isArray(file.personas)) {
      this.#broken = true;
      this.#logger.error("人格库的 personas 必须是数组；修好文件前不会写入");
      return;
    }
    for (const raw of file.personas) {
      const persona = normalizePersona(raw);
      if (persona === null) {
        this.#logger.warn("人格库里有一条格式不正确的条目，已忽略");
        continue;
      }
      this.#personas.set(persona.id, persona);
    }
  }

  #persistPersonas(personas: Map<string, PersonaInfo>): void {
    if (this.#broken) {
      throw new ApiError("人格库文件读取失败，修好它之前不能写入", 500);
    }
    try {
      writeConfigFileAt(this.#filePath, {
        personas: [...personas.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
      } as PersonasFile);
    } catch (err) {
      this.#logger.error(`写入人格库失败: ${errorMessage(err)}`);
      throw new ApiError("保存人格失败，详情见服务端日志", 500, { cause: err });
    }
  }
}
