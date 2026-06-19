import "./styles.css";
import { ApiClient } from "./api.js";
import type { Message, Session } from "@atri/shared";

const api = new ApiClient();

interface State {
  sessions: Session[];
  active: Session | null;
  log: Message[];
}

const state: State = { sessions: [], active: null, log: [] };

const el = <T extends HTMLElement>(sel: string): T => {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`缺少元素: ${sel}`);
  return node;
};

function render(): void {
  el("#sessions").innerHTML = state.sessions
    .map(
      (s) =>
        `<li data-id="${s.id}" class="${s.id === state.active?.id ? "active" : ""}">${escapeHtml(s.title)}</li>`,
    )
    .join("");

  el("#log").innerHTML = state.log
    .map((m) => `<div class="msg ${m.role}"><b>${m.role}</b>: ${escapeHtml(m.content)}</div>`)
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

async function refresh(): Promise<void> {
  const { sessions } = await api.listSessions();
  state.sessions = sessions;
  render();
}

async function ensureSession(): Promise<void> {
  if (state.active) return;
  const { session } = await api.createSession("首个会话");
  state.active = session;
  await refresh();
}

async function send(text: string): Promise<void> {
  await ensureSession();
  if (!state.active) return;
  const userMsg: Message = {
    id: crypto.randomUUID(),
    sessionId: state.active.id,
    role: "user",
    content: text,
    createdAt: new Date().toISOString(),
  };
  state.log.push(userMsg);
  render();
  const { message } = await api.sendMessage(state.active.id, text);
  state.log.push(message as Message);
  render();
}

function wire(): void {
  el<HTMLButtonElement>("#new-session").onclick = async () => {
    const { session } = await api.createSession();
    state.active = session;
    state.log = [];
    await refresh();
  };

  el<HTMLUListElement>("#sessions").onclick = (ev) => {
    const id = (ev.target as HTMLElement).dataset.id;
    const found = state.sessions.find((s) => s.id === id);
    if (found) {
      state.active = found;
      state.log = [];
      render();
    }
  };

  el<HTMLFormElement>("#composer").onsubmit = async (ev) => {
    ev.preventDefault();
    const input = el<HTMLInputElement>("#input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    await send(text);
  };

  api.connect((frame) => {
    if (frame.type === "message" && frame.message.sessionId === state.active?.id) {
      // 服务端会回显双方消息；上面的本地乐观插入已覆盖用户轮次，
      // 因此这里只追加助手回复。
      if (frame.message.role === "assistant") {
        state.log.push(frame.message);
        render();
      }
    }
  });
}

async function main(): Promise<void> {
  wire();
  await refresh();
}

void main();
