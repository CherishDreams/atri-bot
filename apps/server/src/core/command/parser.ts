/**
 * 指令解析。刻意不含注册表知识：这里只回答「这条文本像不像一条指令」，
 * 「像不像」之后「是不是」由注册表回答（`CommandRegistry.find`）。
 */
import { DEFAULT_COMMAND_PREFIX } from "./types.ts";

/** 解析结果：指令名（不含前缀）与去掉前缀、指令名之后的剩余文本。 */
export interface ParsedCommand {
  name: string;
  raw: string;
}

/**
 * 按唤醒前缀解析一条文本。命中返回指令名与剩余参数串，否则 `null`。
 *
 * 两条规则：
 * - **前缀是必经之路**：`wakePrefix` 配成空串关闭群聊唤醒门槛时，`prefix`
 *   由调用方传缺省的 `/`（见引擎里那条换算），指令不会因为门槛关闭而失联 ——
 *   否则「关闭唤醒」会顺手把指令系统整个关掉，而那从来不是用户改这个配置的意图。
 * - 名字取第一个空白前的段落，大小写交给注册表归一；剩余文本原样保留
 *（指令自己决定要不要再 trim），这样「/say  你好 」的连续空格语义由指令自己定。
 */
export function parseCommand(text: string, prefix: string): ParsedCommand | null {
  const lead = prefix === "" ? DEFAULT_COMMAND_PREFIX : prefix;
  if (lead === "" || !text.startsWith(lead)) return null;
  const rest = text.slice(lead.length);
  const matched = /^\s*(\S+)([\s\S]*)$/.exec(rest);
  if (!matched) return null;
  return { name: matched[1] ?? "", raw: (matched[2] ?? "").trim() };
}

/**
 * 把参数串拆成列表：按空白切，成对引号内的内容算一个参数（引号本身剥掉）。
 *
 * 引号没有闭合时**吃到结尾**（整段当一个参数）：悄悄拆开会把一句没打完的话
 * 变成几个谁也看不懂的碎片，而「当一个参数」至少保住了用户的原意。
 * 不支持转义：指令参数是短句，不是 shell。
 */
export function splitCommandArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of raw) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== "" || started) args.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
  }
  if (current !== "" || started) args.push(current);
  return args;
}
