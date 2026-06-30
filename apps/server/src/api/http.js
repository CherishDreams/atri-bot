/** JSON HTTP 处理的辅助函数。 */

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/**
 * 开启一个 SSE 响应。
 *
 * `x-accel-buffering: no` 是给 Nginx 用的：不加这一行，反代会把整个响应缓冲到
 * 结束才吐出，流式就白做了。`cache-control: no-store` 同理——中间层缓存增量流
 * 毫无意义，还可能把上一个请求的内容喂给下一个。
 */
export function startSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  // 立刻发一个注释帧：让客户端（以及任何中间层）马上认为连接已建立，
  // 避免在等待上游首个 token 期间被判定为超时。
  res.write(": connected\n\n");
}

/** 发一个 SSE 事件。默认事件名即 `message`，前端 SDK 会解析 data 里的 JSON。 */
export function sendSse(res, data, event) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** 读取并解析 JSON 请求体，带大小上限。 */
export async function readJson(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("JSON 请求体格式错误");
  }
}
