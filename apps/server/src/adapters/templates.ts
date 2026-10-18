import { ApiError } from "#core/errors.ts";

/**
 * 可添加的适配器类型与它们的表单字段。
 *
 * 这里不是「插件 schema」的复刻：适配器类型是**框架内置**的（NapCat 等），
 * 字段集合随代码发布；用户只能填值，不能声明新类型。因此模板写在源码里，
 * 与 `provider/factory.ts` 的 `TYPES` 表同一层级。
 *
 * v1 的字段值统一是字符串：NapCat 的 url/token 就是字符串；以后真需要数字/布尔，
 * 再扩 `AdapterSettingField.type` 与校验，而不是先把任意 JSON 塞进 settings。
 */
export interface AdapterSettingField {
  key: string;
  label: string;
  type: "text" | "password";
  required: boolean;
  default: string;
  placeholder?: string;
  hint?: string;
  /** 非空时的正则（字符串形式，直接进生成 SDK 的规格）。 */
  pattern?: string;
}

export interface AdapterTemplate {
  type: string;
  name: string;
  description: string;
  fields: AdapterSettingField[];
}

export type AdapterSettings = Record<string, string>;

export const ADAPTER_ID_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";

export const ADAPTER_TEMPLATES: AdapterTemplate[] = [
  {
    type: "napcat",
    name: "NapCat",
    description: "通过 OneBot 11 反向 WebSocket 接入 QQ：atri-bot 监听，NapCat 连入。",
    fields: [
      {
        key: "host",
        label: "监听地址",
        type: "text",
        required: true,
        default: "0.0.0.0",
        placeholder: "0.0.0.0",
        hint: "atri-bot 接受 NapCat 连接的地址；本机可填 127.0.0.1，容器互连通常填 0.0.0.0。",
      },
      {
        key: "port",
        label: "监听端口",
        type: "text",
        required: true,
        default: "6199",
        placeholder: "6199",
        hint: "NapCat 的 WebSocket 客户端会连到这个端口。",
        pattern: "^[0-9]{1,5}$",
      },
      {
        key: "path",
        label: "WebSocket 路径",
        type: "text",
        required: true,
        default: "/ws",
        placeholder: "/ws",
        hint: "NapCat 客户端 URL 的路径部分。",
        pattern: "^/",
      },
      {
        key: "token",
        label: "Access Token",
        type: "password",
        required: true,
        default: "",
        hint: "NapCat 的 WebSocket 客户端里填同一个 token；添加时会自动生成一个。",
      },
    ],
  },
];

export function adapterTemplate(type: string): AdapterTemplate | null {
  return ADAPTER_TEMPLATES.find((template) => template.type === type) ?? null;
}

export function isAdapterId(value: string): boolean {
  return new RegExp(ADAPTER_ID_PATTERN).test(value);
}

export function assertAdapterId(value: string): void {
  if (!isAdapterId(value)) {
    throw new ApiError(
      `适配器 id「${value}」不合法：只允许小写字母、数字与 . _ -，首字符必须是字母或数字，长度 1–64`,
      400,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function defaultSettings(template: AdapterTemplate): AdapterSettings {
  return Object.fromEntries(template.fields.map((field) => [field.key, field.default]));
}

/**
 * 校验并补全一份 settings。
 *
 * 允许前端只发改过的项：缺省的必填项报错，缺省的可选项填默认值。
 * 未知键直接拒绝 —— 拼错的 `tokne` 若被静默丢掉，用户会以为保存成功了。
 */
export function validateAdapterSettings(type: string, raw: unknown): AdapterSettings {
  const template = adapterTemplate(type);
  if (template === null) throw new ApiError(`不支持的适配器类型：${type}`, 400);
  if (!Array.isArray(raw)) {
    throw new ApiError("settings 必须是 [{ key, value }] 数组", 400);
  }

  const byKey = new Map(template.fields.map((field) => [field.key, field]));
  const seen = new Set<string>();
  const values: AdapterSettings = {};
  for (const item of raw) {
    if (!isRecord(item) || typeof item.key !== "string" || typeof item.value !== "string") {
      throw new ApiError("settings 的每一项必须是 { key, value }（值必须是字符串）", 400);
    }
    const field = byKey.get(item.key);
    if (field === undefined) throw new ApiError(`适配器配置项「${item.key}」不存在`, 400);
    if (seen.has(item.key)) throw new ApiError(`适配器配置项「${item.key}」重复提交`, 400);
    seen.add(item.key);
    values[item.key] = item.value;
  }

  for (const field of template.fields) {
    const value = values[field.key] ?? field.default;
    if (field.required && value.trim() === "") {
      throw new ApiError(`缺少必填项「${field.label}」`, 400);
    }
    if (field.pattern !== undefined && value !== "" && !new RegExp(field.pattern).test(value)) {
      throw new ApiError(`「${field.label}」格式不对`, 400);
    }
    values[field.key] = value;
  }

  if (type === "napcat") {
    const port = Number(values.port ?? "");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ApiError("监听端口必须是 1–65535 的整数", 400);
    }
    if (!(values.path ?? "").startsWith("/")) {
      throw new ApiError("WebSocket 路径必须以 / 开头", 400);
    }
    if ((values.token ?? "").trim() === "") {
      throw new ApiError("Access Token 不能为空", 400);
    }
  }
  return values;
}

/** settings -> 表单/API 的数组形状；总是包含模板里的全部字段（缺省用 default）。 */
export function settingsEntries(
  type: string,
  settings: AdapterSettings,
): { key: string; value: string }[] {
  const template = adapterTemplate(type);
  if (template === null) {
    return Object.entries(settings).map(([key, value]) => ({ key, value }));
  }
  return template.fields.map((field) => ({
    key: field.key,
    value: settings[field.key] ?? field.default,
  }));
}

/**
 * 旧版 `atri.config.json` 的 `adapters.<id>` 是平铺的（url/token 直接挂在条目上）。
 * 迁移时按当前模板逐字段取字符串；未知字段不搬，避免把历史垃圾带进新文件。
 */
export function settingsFromLegacy(type: string, entry: Record<string, unknown>): AdapterSettings {
  const template = adapterTemplate(type);
  if (template === null) return {};
  return Object.fromEntries(
    template.fields.map((field) => [
      field.key,
      typeof entry[field.key] === "string" ? (entry[field.key] as string) : field.default,
    ]),
  );
}
