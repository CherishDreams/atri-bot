import { sendError } from "./http.js";

/** Cookie 的最大存活秒数，与 AuthManager 的 15 天绝对有效期保持一致。 */
const MAX_AGE_SECONDS = 15 * 24 * 60 * 60;

/**
 * 解析 Cookie 头。只取第一个同名项（浏览器不会重复下发，重复项通常意味着人为构造）。
 * 值可能被 `encodeURIComponent` 处理过，因此逐个解码；解码失败则退回原始值。
 */
export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};

  const jar = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name.length === 0 || name in jar) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      jar[name] = decodeURIComponent(raw);
    } catch {
      jar[name] = raw;
    }
  }
  return jar;
}

/**
 * 写入会话 Cookie。HttpOnly 让脚本读不到令牌，SameSite=Lax 挡住跨站表单提交，
 * 同时保留「从外部链接点进控制台仍然带着登录态」的体验。
 */
export function setSessionCookie(res, name, token, { secure = false } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${MAX_AGE_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  appendCookie(res, parts.join("; "));
}

/** 清 Cookie：同名 + Max-Age=0，其余属性必须与写入时一致，否则浏览器不会覆盖。 */
export function clearSessionCookie(res, name, { secure = false } = {}) {
  const parts = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  appendCookie(res, parts.join("; "));
}

/**
 * 读取当前请求的登录态。未通过时自行回 401 并返回 null，
 * 调用方只需 `const session = requireAuth(...); if (!session) return;`。
 */
export function requireAuth(auth, req, res) {
  const token = parseCookies(req)[auth.cookieName];
  const session = token ? auth.getByToken(token) : null;

  if (!session) {
    sendError(res, 401, "未认证");
    return null;
  }
  return session;
}

/** 追加而非覆盖 Set-Cookie，避免一次响应里的多个 Cookie 互相顶掉。 */
function appendCookie(res, value) {
  const existing = res.getHeader("set-cookie");
  if (!existing) {
    res.setHeader("set-cookie", value);
  } else if (Array.isArray(existing)) {
    res.setHeader("set-cookie", [...existing, value]);
  } else {
    res.setHeader("set-cookie", [existing, value]);
  }
}
