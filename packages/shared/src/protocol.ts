/**
 * 服务端与任意客户端（今天是 dashboard，之后是其他前端）之间的线协议。
 * 每个帧都是带 `type` 判别字段的 JSON，因此可以新增帧类型
 * 而不破坏旧客户端。
 */

import type { Message, Session } from "./types.js";

export type ClientFrame =
  | { type: "ping" }
  | { type: "subscribe"; sessionId: string }
  | { type: "unsubscribe"; sessionId: string };

export type ServerFrame =
  | { type: "pong" }
  | { type: "session"; session: Session }
  | { type: "message"; message: Message }
  | { type: "error"; message: string }
  | { type: "stream"; sessionId: string; delta: string; done: boolean }
  /** 握手后会话失效（过期或被登出）；客户端应清空登录态并跳回登录页。 */
  | { type: "unauthorized"; reason: string };
