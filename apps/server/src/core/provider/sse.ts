/**
 * 极简 SSE（Server-Sent Events）解析。
 *
 * 两家 provider 的流式响应都是 SSE，但事件排布不同：
 * - OpenAI 兼容：只有一个事件名（默认 `message`），每帧 `data: {json}`，
 *   以字面量 `data: [DONE]` 收尾。
 * - Anthropic：每帧带 `event:` 名（`content_block_delta`、`message_stop` …），
 *   没有 `[DONE]`，靠事件类型判断结束。
 *
 * 所以这里只做「按 SSE 规范切帧」，把「这帧是什么意思」留给各自的 provider。
 * 独立成文件的目的就是这段切分逻辑能被单独测试——它是整条流式链路上最容易
 * 出错也最难从集成测试里定位的一环（跨 chunk 切断、CRLF、多行 data）。
 */

/** 一帧 SSE 事件。三个字段都可能有空值：注释帧没有 data，未声明 event 的帧用默认名。 */
export interface SseFrame {
  event: string;
  data: string;
  id: string;
}

/**
 * 把 fetch 的 ReadableStream 逐帧解析成 SSE 事件。
 *
 * 返回类型交给推断（async generator 的三元组类型在不同 TS 版本里写法不同，
 * 显式标注反而会把工程绑在某个版本上）。
 */
export async function* parseSse(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    // 规范允许 CRLF / CR / LF 三种换行。**结尾单独的 `\r` 必须先扣住**再归一化：
    // 它可能只是下一块开头 `\n` 的另一半，提前换成 `\n` 会凭空造出一个空行，
    // 把同一帧的 `event:` 和 `data:` 切成两帧（Anthropic 的帧完全靠 event 分派，
    // 丢了 event 的 data 会静默消失）。这一条只在 chunk 边界落在 CRLF 中间时发生。
    const heldCR = buffer.endsWith("\r") ? "\r" : "";
    const safe = heldCR === "" ? buffer : buffer.slice(0, -1);
    const frames = safe.replace(/\r\n?/g, "\n").split("\n\n");
    // 事件之间以空行分隔。最后一段可能被 chunk 截断，留在 buffer 里等下一块。
    buffer = (frames.pop() ?? "") + heldCR;

    for (const frame of frames) {
      const parsed = parseFrame(frame);
      if (parsed) yield parsed;
    }
  }

  // 上游没补最后一个空行时，收尾的残帧仍然是有效数据，不能丢。
  buffer += decoder.decode();
  const tail = parseFrame(buffer.replace(/\r\n?/g, "\n"));
  if (tail) yield tail;
}

/** 解析单个事件块。返回 null 表示这帧没有 data，可以忽略（例如注释帧）。 */
function parseFrame(frame: string): SseFrame | null {
  const dataLines: string[] = [];
  let event = "";
  let id = "";

  for (const line of frame.split("\n")) {
    // 以冒号开头的是注释（常用作心跳），直接忽略。
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;

    const field = line.slice(0, colon);
    // 规范：冒号后若有一个空格则去掉，多余空格保留。
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") dataLines.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }

  if (dataLines.length === 0) return null;
  // 多行 data 按规范以换行拼接。
  return { event, data: dataLines.join("\n"), id };
}

/** `parseSseJson` 的产出：`payload` 为 null 有两种含义，靠 `data` 是否为 `[DONE]` 区分。 */
export interface SseJsonFrame {
  event: string;
  data: string;
  payload: unknown;
}

/**
 * 逐帧读取 `data:` 的 JSON 载荷，跳过无法解析的帧。
 *
 * 跳过而不是抛错，是因为有些网关会插入非 JSON 的心跳或注释帧；
 * 为了一个心跳把整条流打断得不偿失。但 `[DONE]` 这类哨兵值必须让调用方看见，
 * 所以原样回传字符串，由调用方判断。
 */
export async function* parseSseJson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseJsonFrame> {
  for await (const frame of parseSse(body)) {
    if (frame.data === "[DONE]") {
      yield { event: frame.event, data: "[DONE]", payload: null };
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      continue;
    }
    yield { event: frame.event, data: frame.data, payload };
  }
}
