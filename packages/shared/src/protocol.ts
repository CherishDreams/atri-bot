/**
 * 服务端与任意客户端（今天是 dashboard，之后是其他前端）之间的线协议。
 * 每个帧都是带 `type` 判别字段的 JSON，因此可以新增帧类型
 * 而不破坏旧客户端。
 *
 * ## 这一版收窄过，理由是「没实现的帧类型比删掉更坏」
 * 以前声明了 6 种服务端帧与 3 种入站帧，而全仓只有 `message` 与 `pong` 真的有产生点：
 * `session` / `stream` / `error` 从来没有 `emit` 处，`subscribe` / `unsubscribe` 到了
 * 服务端也只是被忽略（`api/server.ts` 只判 `ping`）。README 却把它们写成了承诺
 * （「向客户端推送 message / stream / error / unauthorized」「收到 unauthorized 应清登录态」），
 * 于是客户端为不存在的事件写了三个分支 —— 那些分支**永远不可达**，而它们看起来像是在工作。
 *
 * 保留的是 `unauthorized`，并且让它真的存在（登录会话被**显式作废**时发一帧再关连接）。
 * 令牌**到期**不发这一帧，那需要服务端定时器，而本仓刻意没有定时器
 * （见 `docs/architecture.md` 的鉴权一节）；到期表现为下一个请求的 401，前端走同一条路。
 *
 * `subscribe` / `unsubscribe` 不实现也不留壳：本仓是单一管理员部署、`broadcast` 就是全量扇出、
 * 客户端 `sessions.ingest` 按 id 去重，按会话订阅是一个规模/授权特性而没有对应的需求。
 * 一个既不走、又会让规格说谎的接缝，正是 `engine.ts` 当初删掉「注入了但没人读的 config」
 * 的那一类东西。将来真要它，它应该跟「让它有意义的那套授权」一起来。
 */

import type { Message } from "./types.js";

/**
 * 服务端会发出的帧类型的**运行时清单**。
 *
 * 为什么需要一份值而不只是类型：`ServerFrame` 是纯类型，类型擦除之后运行时读不到它，
 * 而「声明过的帧类型有没有真的被发出去」这条检查需要在运行时读到清单
 * （`apps/server/test/protocol-frames.test.ts` 就是为它存在的）。
 *
 * 与下面的 union 由 `Frame<T extends ServerFrameType, ...>` 的约束**单向**绑死：
 * 清单里改名或删项，`ServerFrame` 那一侧直接编译不过；反过来（清单多了一帧而没人发）
 * 由那条测试抓。
 */
export const SERVER_FRAME_TYPES = ["pong", "message", "unauthorized"] as const;
export type ServerFrameType = (typeof SERVER_FRAME_TYPES)[number];

/** 客户端会发的帧类型。今天只有心跳。 */
export const CLIENT_FRAME_TYPES = ["ping"] as const;
export type ClientFrameType = (typeof CLIENT_FRAME_TYPES)[number];

/** 一帧 = 一个判别字段 + 该类型独有的键。 */
type Frame<T extends string, Extra extends object = Record<never, never>> = { type: T } & Extra;

export type ClientFrame = Frame<ClientFrameType>;

export type ServerFrame =
  | Frame<"pong">
  | Frame<"message", { message: Message }>
  /**
   * 登录会话被**显式作废**（在别的窗口点了登出，或服务端做了一次全量撤销）时，
   * 只发给用那一个令牌握手的那批连接，发完即关。
   *
   * `reason` 是给人看的一句话，不参与分派 —— 客户端该判的是 `type`，
   * 而不是拿这句话去匹配（那等于把文案变成协议的一部分）。
   */
  | Frame<"unauthorized", { reason: string }>;
