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
