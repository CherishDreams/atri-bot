import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * 路由捕获的参数。
 *
 * 用显式清单而不是 `Record<string, string>`：索引签名在 `noUncheckedIndexedAccess`
 * 下会让每个 handler 取参数都得写一次判空，而「模式里写了 `:id` 就必然有 `id`」
 * 是本路由器唯一保证的事情之一。新增带别的参数的路由时，必须同时在这里加一个键 ——
 * 否则 handler 取不到类型，编译直接不过，这正是我们要的提醒。
 *
 * 写成 `type` 而不是 `interface`：只有对象字面量类型才带隐式索引签名，
 * 而 `match()` 需要把逐键填充出来的 `Record<string, string>` 收窄到它。
 */
export type RouteParams = { id: string };

/**
 * 路由处理函数。`params` 是 `:name` 捕获，永远存在（无命中时压根不会调到这里）。
 *
 * 允许同步返回：`await` 一个非 Promise 是 no-op，今天的调用方就是两种都写。
 */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: RouteParams,
) => void | Promise<void>;

export interface RouteMatch {
  handler: RouteHandler;
  params: RouteParams;
}

interface RegisteredRoute {
  method: string;
  pattern: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

/**
 * 极简模式路由。让 API 层不引入任何依赖且保持显式。
 * 路由按注册顺序匹配，先命中者胜。
 */
export class Router {
  #routes: RegisteredRoute[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    const keys: string[] = [];
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/\/:([A-Za-z0-9_]+)/g, (_m, key) => {
            keys.push(key);
            return "/([^/]+)";
          })
          .replace(/\*/g, ".*") +
        "/?$",
    );
    this.#routes.push({ method, pattern, regex, keys, handler });
    return this;
  }

  /**
   * 已注册的路由（只含方法与模式，不含 handler）。
   *
   * 暴露它是为了让测试能拿真实路由表去比对 `openapi.json`：
   * 规格是手写的，没有这道比对就能悄悄少一个端点，
   * 而生成物与规格永远一致，漂移不会被任何现有检查发现。
   */
  get routes(): Array<{ method: string; pattern: string }> {
    return this.#routes.map(({ method, pattern }) => ({ method, pattern }));
  }

  get(p: string, h: RouteHandler): this {
    return this.add("GET", p, h);
  }
  post(p: string, h: RouteHandler): this {
    return this.add("POST", p, h);
  }
  delete(p: string, h: RouteHandler): this {
    return this.add("DELETE", p, h);
  }

  /**
   * `method` 可能是 undefined：`req.method` 在 node 的类型里是可选的，
   * 而 undefined 匹配不到任何路由，正好落进「未命中 → 交给静态托管」的既有分支。
   */
  match(method: string | undefined, pathname: string): RouteMatch | null {
    for (const r of this.#routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      let malformed = false;
      for (const [i, key] of r.keys.entries()) {
        const raw = m[i + 1];
        // 每个捕获组都是 ([^/]+)，不可能不命中；undefined 只存在于类型层面，
        // 但 noUncheckedIndexedAccess 不认识这个事实，所以显式跳过而不是写 `!`。
        if (raw === undefined) continue;
        try {
          params[key] = decodeURIComponent(raw);
        } catch {
          // 非法百分号编码（例如 `%E0%A4%A`）是**客户端输入错误**，不是服务端故障；
          // 不能让 URIError 穿过这里变成 500 和一条没有意义的堆栈。
          malformed = true;
          break;
        }
      }
      if (malformed) return null;
      // 键来自模式里的 `:name`，与 `RouteParams` 的键一一对应（见该类型的注释）。
      return { handler: r.handler, params: params as RouteParams };
    }
    return null;
  }
}
