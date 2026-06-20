import "./styles.css";
import { ApiClient } from "./api.js";
import type { Message, PluginInfo, Session } from "@atri/shared";

const api = new ApiClient();

interface State {
  sessions: Session[];
  active: Session | null;
  log: Message[];
  plugins: PluginInfo[];
}

const state: State = { sessions: [], active: null, log: [], plugins: [] };

const el = <T extends HTMLElement>(sel: string): T => {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`缺少元素: ${sel}`);
  return node;
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

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

  el("#plugins").innerHTML = state.plugins
    .map((p) => {
      const active = p.status === "active";
      return `<li class="plugin ${p.status}">
        <div class="plugin-info">
          <b>${escapeHtml(p.name)}</b> <span class="ver">v${escapeHtml(p.version)}</span>
          <div class="desc">${escapeHtml(p.description ?? "")}</div>
          <div class="status">${active ? "运行中" : "已禁用"}</div>
        </div>
        <div class="plugin-actions">
          <button data-act="reload" data-id="${p.id}">重载</button>
          <button data-act="${active ? "disable" : "enable"}" data-id="${p.id}">
            ${active ? "禁用" : "启用"}
          </button>
          <button data-act="unload" data-id="${p.id}" class="danger">卸载</button>
        </div>
      </li>`;
    })
    .join("");
}

async function refreshSessions(): Promise<void> {
  const { sessions } = await api.listSessions();
  state.sessions = sessions;
  render();
}

async function refreshPlugins(): Promise<void> {
  const { plugins } = await api.listPlugins();
  state.plugins = plugins;
  render();
}

async function ensureSession(): Promise<void> {
  if (state.active) return;
  const { session } = await api.createSession("首个会话");
  state.active = session;
  await refreshSessions();
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

/** 插件面板操作：重载 / 启用 / 禁用 / 卸载。 */
async function onPluginAction(act: string, id: string): Promise<void> {
  try {
    if (act === "reload") await api.reloadPlugin(id);
    else if (act === "unload") await api.unloadPlugin(id);
    else if (act === "enable") await api.setPluginEnabled(id, true);
    else if (act === "disable") await api.setPluginEnabled(id, false);
  } catch (err) {
    alert(`操作失败: ${(err as Error).message}`);
  } finally {
    await refreshPlugins();
  }
}

function wire(): void {
  el<HTMLButtonElement>("#new-session").onclick = async () => {
    const { session } = await api.createSession();
    state.active = session;
    state.log = [];
    await refreshSessions();
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

  el<HTMLUListElement>("#plugins").onclick = (ev) => {
    const target = ev.target as HTMLElement;
    const act = target.dataset.act;
    const id = target.dataset.id;
    if (act && id) void onPluginAction(act, id);
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
  await Promise.all([refreshSessions(), refreshPlugins()]);
}

void main();
