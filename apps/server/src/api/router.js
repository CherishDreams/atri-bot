/**
 * 极简模式路由。让 API 层不引入任何依赖且保持显式。
 * 路由按注册顺序匹配，先命中者胜。
 */
export class Router {
  /** @type {Array<{method: string, pattern: string, regex: RegExp, keys: string[], handler: Function}>} */
  #routes = [];

  add(method, pattern, handler) {
    const keys = [];
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
   *
   * @returns {Array<{method: string, pattern: string}>}
   */
  get routes() {
    return this.#routes.map(({ method, pattern }) => ({ method, pattern }));
  }

  get(p, h) {
    return this.add("GET", p, h);
  }
  post(p, h) {
    return this.add("POST", p, h);
  }
  delete(p, h) {
    return this.add("DELETE", p, h);
  }

  /** @returns {{handler: Function, params: Record<string,string>} | null} */
  match(method, pathname) {
    for (const r of this.#routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return null;
  }
}
