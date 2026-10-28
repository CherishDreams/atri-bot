/**
 * 发送侧的拟人化处理：智能分段与去机器味。
 *
 * 这些处理**只发生在适配器发送路径**（`MessageAdapter` 拿到回复、切块之前），
 * 控制台不受影响 —— 控制台是 Markdown 渲染器，剥掉标记反而毁掉排版。
 */

/**
 * 相邻短句合并的下限（字符）：攒到这么多才封口成一条，避免「好」「的」各一条。
 * 换行边界不受它约束 —— 用户/模型显式换行就是想分段。本仓自选值，没有上游依据。
 */
export const SMART_CHUNK_MERGE_CHARS = 60;
/** 一条气泡的最短目标长度：不足就继续吞下一句。 */
const MIN_BUBBLE_CHARS = 12;

/** 句子边界符：中英句号、问叹号、省略号（含连写）、换行。 */
const BOUNDARY = /^[。！？!?…\n]$/;
const BOUNDARY_NOT_NEWLINE = /^[。！？!?…]$/;

/**
 * 按句子智能分段。
 *
 * 与纯长度硬切的区别在**断点的偏好**：优先在句号/问号/叹号/换行处断开，
 * 短句各成一条消息（IM 里几条短气泡比一堵文字墙更像人）；相邻短句合并到
 * 60 字以内再发，避免「好」「的」各一条的神经质。超过平台上限的长句
 * 退回按字符硬切兜底（语义与 message.ts 的 chunkText 一致，这里独立一份
 * 免得 companion 反向依赖 adapters）。
 */
export function smartChunk(text: string, max: number): string[] {
  const limit = Number.isInteger(max) && max > 0 ? max : 1500;

  // 先按边界切句：边界符归前一段；省略号/连写标点整串吃进。
  // hardEnd = 这段以换行收尾 —— 显式换行就是想分段，合并时立即封口。
  // 句号后紧跟换行会先切出一个空片段：它的 hardEnd 回填给上一段真实内容。
  const pieces: { text: string; hardEnd: boolean }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (!BOUNDARY.test(ch)) continue;
    if (BOUNDARY_NOT_NEWLINE.test(ch)) {
      let end = i + 1;
      while (end < text.length && BOUNDARY_NOT_NEWLINE.test(text[end] ?? "")) end += 1;
      push(text.slice(start, end), false);
      start = end;
      i = end - 1;
    } else {
      push(text.slice(start, i), true);
      start = i + 1;
    }
  }
  push(text.slice(start), false);

  function push(raw: string, hardEnd: boolean): void {
    const piece = raw.trim();
    if (piece === "") {
      // 空片段带着换行语义：上一段（真实内容）其实以换行收尾。
      if (hardEnd && pieces.length > 0) pieces[pieces.length - 1]!.hardEnd = true;
      return;
    }
    pieces.push({ text: piece, hardEnd });
  }

  if (pieces.length === 0) return hardChunk(text, limit);

  // 超上限的长句先硬切，再参与合并。
  const bounded = pieces.flatMap(({ text: piece, hardEnd }) =>
    piece.length > limit
      ? hardChunk(piece, limit).map((part, index, all) => ({
          text: part,
          hardEnd: hardEnd || index < all.length - 1,
        }))
      : [{ text: piece, hardEnd }],
  );
  const out: string[] = [];
  let current = "";
  for (const piece of bounded) {
    if (current !== "" && current.length + piece.text.length > limit) {
      out.push(current);
      current = "";
    }
    current = current === "" ? piece.text : current + piece.text;
    if (piece.hardEnd || current.length >= MIN_BUBBLE_CHARS) {
      out.push(current);
      current = "";
    }
  }
  if (current !== "") out.push(current);
  return out;
}

/** 去机器味：剥掉 IM 里刺眼的 markdown 标记，保留文字内容。 */
export function stripMarkdown(text: string): string {
  return (
    text
      // [文字](url) -> 文字（url）
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1（$2）")
      // 强调与代码标记：**粗**、__粗__、*斜*、`码`、~~删~~
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      // 标题、引用与无序列表的行首符号（保留文字）。
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/^[-*]\s+/gm, "")
      .trim()
  );
}

function hardChunk(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    out.push(rest.slice(0, max).trimEnd());
    rest = rest.slice(max).trimStart();
  }
  if (rest !== "") out.push(rest);
  return out;
}
