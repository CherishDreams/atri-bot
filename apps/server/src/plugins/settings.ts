import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, errorMessage } from "#core/errors.ts";

/**
 * 插件的用户配置：`_conf_schema.json`（插件作者声明有哪些项）+ `config.json`（操作者填的值）。
 *
 * 两件事刻意分开：
 *
 * - **schema 是代码的一部分**，跟着插件目录走，升级时一起换；它决定表单长什么样。
 * - **值是数据**，落在 `<dataDir>/profiles/<pid>/plugins/<pluginId>/config.json`，每份档
 *   各一份，卸载/禁用/重载都不删（与 `ctx.dataDir` 同一条）。
 *
 * 本模块只做纯逻辑（除了 `readSchema` 要读那一份声明文件）：校验、默认值、合并。
 * 具体写到哪个路径、什么时候重载插件，由 `PluginManager` 决定 —— 与 `config/` 分层
 * 同一条规矩，文件路径与生命周期不在这里猜。
 */

/** 插件目录里的声明文件名。与 AstrBot 同名：认识那套插件的人不用再学一遍。 */
export const PLUGIN_SCHEMA_FILE = "_conf_schema.json";
/**
 * 插件数据目录里的配置文件名。
 *
 * **这是保留名**：插件自己往 `ctx.dataDir` 里写别的文件随便，但不能写 `config.json` ——
 * 框架会把它当成用户配置读出来、并在保存时整份重写。
 */
export const PLUGIN_CONFIG_FILE = "config.json";

export type PluginSettingType = "string" | "text" | "int" | "float" | "bool" | "select";
export type PluginSettingValue = string | number | boolean;
/** 交给插件的生效值（schema 默认值被 `config.json` 覆盖之后）。 */
export type PluginSettingsValues = Record<string, PluginSettingValue>;

export interface PluginSettingField {
  key: string;
  type: PluginSettingType;
  /** 表单上那一行标题。 */
  description: string;
  /** 标题下面那句补充说明（可选）。 */
  hint?: string;
  default: PluginSettingValue;
  /** `select` 的候选项。 */
  options?: string[];
  /** `int` / `float` 的下界与上界。 */
  min?: number;
  max?: number;
}

/** 一份 schema 的读取结果：`present` 区分「没有声明」与「声明了但读不出来」。 */
export interface PluginSettingsSchema {
  present: boolean;
  fields: PluginSettingField[];
  error: string | null;
}

export interface PluginSettingEntry extends PluginSettingField {
  value: PluginSettingValue;
}

/** 返回给控制台的那一份：字段定义 + **生效值**（默认值被文件覆盖之后）。 */
export interface PluginSettingsView {
  id: string;
  configurable: boolean;
  fields: PluginSettingEntry[];
  /** schema 存在但不可用（坏 JSON、不支持的 type…），此时 `fields` 为空。 */
  schemaError: string | null;
  /** 配置文件读不出来，或某些已存值无效（已按默认值显示）。 */
  configError: string | null;
}

export const SETTING_TYPES: ReadonlySet<string> = new Set([
  "string",
  "text",
  "int",
  "float",
  "bool",
  "select",
] as const);

const MAX_SCHEMA_FIELDS = 100;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_STRING_LENGTH = 2000;
const MAX_TEXT_LENGTH = 20000;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_HINT_LENGTH = 500;
const SETTING_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** 原型链上的名字一律拒绝：`{ "__proto__": … }` 不是一条配置，是一次原型污染。 */
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 值是否符合字段声明；符合返回 `null`，否则返回一句可以直接拼进错误/提示的中文。 */
function valueProblem(field: PluginSettingField, value: unknown): string | null {
  switch (field.type) {
    case "string":
      return typeof value === "string" && value.length <= MAX_STRING_LENGTH
        ? null
        : `必须是字符串（不超过 ${MAX_STRING_LENGTH} 字）`;
    case "text":
      return typeof value === "string" && value.length <= MAX_TEXT_LENGTH
        ? null
        : `必须是字符串（不超过 ${MAX_TEXT_LENGTH} 字）`;
    case "int": {
      if (typeof value !== "number" || !Number.isInteger(value)) return "必须是整数";
      return rangeProblem(field, value);
    }
    case "float": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "必须是数字";
      return rangeProblem(field, value);
    }
    case "bool":
      return typeof value === "boolean" ? null : "必须是布尔值";
    case "select":
      return typeof value === "string" && (field.options ?? []).includes(value)
        ? null
        : `只能取 ${(field.options ?? []).map((o) => `「${o}」`).join("") || "候选项"} 之一`;
  }
}

function rangeProblem(field: PluginSettingField, value: number): string | null {
  if (field.min !== undefined && value < field.min) return `不能小于 ${field.min}`;
  if (field.max !== undefined && value > field.max) return `不能大于 ${field.max}`;
  return null;
}

/**
 * 把一条声明收窄成 `PluginSettingField`。任何一处不合规都抛普通 `Error`：
 * 这是**插件作者的错**，由 `readSchema` 统一兜成 `schemaError`，不是 HTTP 错误。
 */
function readField(key: string, def: unknown): PluginSettingField {
  if (!SETTING_KEY.test(key) || RESERVED_KEYS.has(key)) {
    throw new Error(
      `配置项名「${key}」不合法：只允许字母、数字与下划线，不能以数字开头，且不能是原型链上的名字`,
    );
  }
  if (!isRecord(def)) throw new Error(`配置项「${key}」的定义必须是一个对象`);

  const type = def.type;
  if (typeof type !== "string" || !SETTING_TYPES.has(type)) {
    throw new Error(
      `配置项「${key}」的 type 不支持：${String(type)}（支持 string / text / int / float / bool / select）`,
    );
  }
  const settingType = type as PluginSettingType;

  const description = def.description;
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error(`配置项「${key}」缺少 description`);
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`配置项「${key}」的 description 超过 ${MAX_DESCRIPTION_LENGTH} 字`);
  }
  const hint = def.hint;
  if (hint !== undefined) {
    if (typeof hint !== "string") throw new Error(`配置项「${key}」的 hint 必须是字符串`);
    if (hint.length > MAX_HINT_LENGTH) {
      throw new Error(`配置项「${key}」的 hint 超过 ${MAX_HINT_LENGTH} 字`);
    }
  }

  let options: string[] | undefined;
  if (settingType === "select") {
    const raw = def.options;
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((o) => typeof o !== "string")) {
      throw new Error(`配置项「${key}」是 select，必须提供非空的字符串 options`);
    }
    options = [...new Set(raw as string[])];
    if (options.length !== raw.length) throw new Error(`配置项「${key}」的 options 有重复项`);
  }

  let min: number | undefined;
  let max: number | undefined;
  if (settingType === "int" || settingType === "float") {
    const rawMin = def.min;
    const rawMax = def.max;
    if (rawMin !== undefined && (typeof rawMin !== "number" || !Number.isFinite(rawMin))) {
      throw new Error(`配置项「${key}」的 min 必须是数字`);
    }
    if (rawMax !== undefined && (typeof rawMax !== "number" || !Number.isFinite(rawMax))) {
      throw new Error(`配置项「${key}」的 max 必须是数字`);
    }
    min = rawMin as number | undefined;
    max = rawMax as number | undefined;
    if (min !== undefined && max !== undefined && min > max) {
      throw new Error(`配置项「${key}」的 min 大于 max`);
    }
    if (settingType === "int") {
      if (min !== undefined && !Number.isInteger(min))
        throw new Error(`配置项「${key}」的 min 必须是整数`);
      if (max !== undefined && !Number.isInteger(max))
        throw new Error(`配置项「${key}」的 max 必须是整数`);
    }
  }

  if (!Object.hasOwn(def, "default")) throw new Error(`配置项「${key}」缺少 default`);

  const field: PluginSettingField = {
    key,
    type: settingType,
    description,
    ...(hint === undefined ? {} : { hint }),
    default: def.default as PluginSettingValue,
    ...(options === undefined ? {} : { options }),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
  const problem = valueProblem(field, field.default);
  if (problem) throw new Error(`配置项「${key}」的 default ${problem}`);
  return field;
}

/** 解析已经 `JSON.parse` 过的 schema。任何一项不合规都整份作废（宁可没有表单，不给半个）。 */
export function parseSchema(raw: unknown): { fields: PluginSettingField[]; error: string | null } {
  if (!isRecord(raw)) return { fields: [], error: `${PLUGIN_SCHEMA_FILE} 顶层必须是一个对象` };
  const entries = Object.entries(raw);
  if (entries.length > MAX_SCHEMA_FIELDS) {
    return { fields: [], error: `${PLUGIN_SCHEMA_FILE} 的配置项超过 ${MAX_SCHEMA_FIELDS} 个` };
  }
  const fields: PluginSettingField[] = [];
  try {
    for (const [key, def] of entries) fields.push(readField(key, def));
  } catch (err) {
    return { fields: [], error: errorMessage(err) };
  }
  return { fields, error: null };
}

/**
 * 读插件目录里的 `_conf_schema.json`。
 *
 * 读不出来**不抛**：schema 坏了插件仍然要能加载（只坏表单，不坏功能），
 * 原因走 `schemaError` 给操作者。
 */
export function readSchema(pluginDir: string): PluginSettingsSchema {
  const path = join(pluginDir, PLUGIN_SCHEMA_FILE);
  if (!existsSync(path)) return { present: false, fields: [], error: null };

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return {
      present: true,
      fields: [],
      error: `读不出 ${PLUGIN_SCHEMA_FILE}：${errorMessage(err)}`,
    };
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_SCHEMA_BYTES) {
    return { present: true, fields: [], error: `${PLUGIN_SCHEMA_FILE} 超过 64 KiB` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      present: true,
      fields: [],
      error: `${PLUGIN_SCHEMA_FILE} 不是合法 JSON：${errorMessage(err)}`,
    };
  }
  const { fields, error } = parseSchema(parsed);
  return { present: true, fields, error };
}

/**
 * 默认值 + 已保存值 → 生效值。
 *
 * 不合法/缺失的已存值退回默认值，并把它们的键**点名**（不是静默修正）：界面上那句
 * `configError` 要能让操作者知道去哪一项看。未知键直接忽略 —— 它们仍留在文件里，
 * 由保存时的读-改-写原样带回去。
 */
export function effectiveValues(
  fields: PluginSettingField[],
  saved: Record<string, unknown>,
): { values: PluginSettingsValues; configError: string | null } {
  const values: PluginSettingsValues = {};
  const invalid: string[] = [];
  for (const field of fields) {
    if (!Object.hasOwn(saved, field.key)) {
      values[field.key] = field.default;
      continue;
    }
    const raw = saved[field.key];
    if (valueProblem(field, raw) === null) {
      values[field.key] = raw as PluginSettingValue;
    } else {
      values[field.key] = field.default;
      invalid.push(field.key);
    }
  }
  return {
    values,
    configError:
      invalid.length === 0
        ? null
        : `配置项 ${invalid.map((k) => `「${k}」`).join("")} 已保存的值无效，已按默认值显示`,
  };
}

/**
 * 校验一次保存请求，返回收窄后的条目。
 *
 * **全部验完才返回**：调用方据此保证「要么全写、要么一个字节都不写」。
 * 收的是 `unknown` 而不是类型好的形状：请求体来自网络，类型在运行时收窄。
 */
export function validatePatch(fields: PluginSettingField[], raw: unknown): PluginSettingEntry[] {
  if (!Array.isArray(raw)) throw new ApiError("`values` 必须是数组", 400);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const seen = new Set<string>();
  const entries: PluginSettingEntry[] = [];

  for (const item of raw) {
    if (!isRecord(item) || typeof item.key !== "string") {
      throw new ApiError("`values` 的每一项必须是 { key, value }", 400);
    }
    const field = byKey.get(item.key);
    if (!field) throw new ApiError(`配置项「${item.key}」不存在`, 400);
    if (seen.has(item.key)) throw new ApiError(`配置项「${item.key}」重复提交`, 400);
    seen.add(item.key);
    if (!Object.hasOwn(item, "value")) {
      throw new ApiError(`配置项「${item.key}」缺少 value`, 400);
    }
    const problem = valueProblem(field, item.value);
    if (problem) throw new ApiError(`配置项「${item.key}」${problem}`, 400);
    entries.push({ ...field, value: item.value as PluginSettingValue });
  }
  return entries;
}

/** 把校验过的条目写进文件对象，只覆盖声明的键（其余键原样保留）。 */
export function applyPatch(
  file: Record<string, unknown>,
  entries: PluginSettingEntry[],
): Record<string, unknown> {
  for (const entry of entries) file[entry.key] = entry.value;
  return file;
}
