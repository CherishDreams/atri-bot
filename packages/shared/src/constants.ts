/** 服务端与 dashboard 共享的默认值。 */

export const DEFAULT_SERVER_PORT = 6185;

export const DEFAULT_SERVER_HOST = "127.0.0.1";

/** 所有 HTTP API 路由的基础路径。 */
export const API_PREFIX = "/api/v1";

/** 向 dashboard 推送会话事件的 WebSocket 端点。 */
export const WS_PATH = "/ws";

export const APP_NAME = "atri-bot";

/** 承载登录会话令牌的 Cookie 名。令牌只走 Cookie，不进协议体。 */
export const DEFAULT_AUTH_COOKIE_NAME = "atri_session";

/** 未登录时前端被重定向到的路由。 */
export const AUTH_LOGIN_PATH = "/login";

/**
 * 第一次落盘时用的配置档 id（服务端 `config/profiles.ts` 从这里 re-export 它）。
 *
 * 放在 shared 的理由不是「两边都用就得共享」这么轻：dashboard 在补 `?profile=` 时要优先选它，
 * 而这个 id 是服务端 seed 时写下的 —— 各写一份字面量的话，服务端改 seed 落点，
 * 前端会安静地不再优先选那份档，症状只是「进来看不到默认档」，没有任何报错。
 */
export const DEFAULT_PROFILE_ID = "default";
