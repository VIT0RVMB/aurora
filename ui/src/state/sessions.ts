import { Channel } from "@tauri-apps/api/core";
import { createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { core, errorKind, errorMessage, type NewSession, type SessionInfo } from "../lib/ipc";
import * as panes from "../lib/panes";
import { displayName, sameFolder, sortSessions } from "../lib/sessions";
import { load, save } from "../lib/storage";
import type { TermHandle } from "../lib/terminal";
import { theme } from "./theme";
import { confirm, notify, setTerminalVisible, toggleTerminal } from "./ui";
import { workspace } from "./workspace";

/** Every session the daemon knows, from all workspaces. */
export const [all, setAll] = createStore<SessionInfo[]>([]);
export const [layout, setLayoutSignal] = createSignal<panes.Layout>(panes.emptyLayout());
/** null until the first connection attempt finishes. */
export const [connected, setConnected] = createSignal<boolean | null>(null);
/** Session whose terminal has keyboard focus, if any. */
export const [focusedTerm, setFocusedTerm] = createSignal<string | null>(null);

const { here, waiting } = createRoot(() => {
  const here = createMemo(() => {
    const root = workspace()?.root;
    return root ? sortSessions(all.filter((s) => sameFolder(s.workspace, root))) : [];
  });
  const waiting = createMemo(() => here().filter((s) => s.alive && s.status === "waiting").length);
  return { here, waiting };
});
/** Sessions of the open workspace, the ones needing you first. */
export { here, waiting };

export const activeSession = () => panes.focusedPane(layout()).active;
export const hasTabs = () => layout().panes.some((p) => p.tabs.length > 0);
export const byId = (id: string | null | undefined) => (id ? all.find((s) => s.id === id) : undefined);

function layoutKey() {
  const root = workspace()?.root;
  return root ? `panes:${root}` : null;
}

function setLayout(l: panes.Layout) {
  setLayoutSignal(l);
  const key = layoutKey();
  if (key) save(key, l);
}

// ── terminals ──────────────────────────────────────────────────────────────

const terms = new Map<string, TermHandle>();
let termModule: Promise<typeof import("../lib/terminal")> | null = null;
const loadTermModule = () => (termModule ??= import("../lib/terminal"));
const resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Keystrokes must reach the PTY in order. Each invoke runs on its own task in
// the core, so send one at a time and batch whatever was typed meanwhile.
const inputQueues = new Map<string, { buf: string; busy: boolean }>();

function sendInput(id: string, data: string) {
  let q = inputQueues.get(id);
  if (!q) inputQueues.set(id, (q = { buf: "", busy: false }));
  q.buf += data;
  if (q.busy) return;
  q.busy = true;
  void (async () => {
    while (q.buf) {
      const chunk = q.buf;
      q.buf = "";
      await core.sessionInput(id, chunk).catch(() => {});
    }
    q.busy = false;
  })();
}

function attach(id: string, handle: TermHandle) {
  const ch = new Channel<ArrayBuffer>();
  ch.onmessage = (buf) => handle.write(new Uint8Array(buf));
  core.sessionAttach(id, ch).catch((e) => notify(`terminal ${byId(id)?.name ?? id}: ${errorMessage(e)}`, "error"));
}

/** The terminal for a session, created on first use. */
export async function terminal(id: string): Promise<TermHandle> {
  const existing = terms.get(id);
  if (existing) return existing;
  const { createTerminal } = await loadTermModule();
  const again = terms.get(id);
  if (again) return again;
  const handle: TermHandle = createTerminal({
    onData: (d) => sendInput(id, d),
    onResize: (cols, rows) => {
      clearTimeout(resizeTimers.get(id));
      resizeTimers.set(id, setTimeout(() => void core.sessionResize(id, cols, rows).catch(() => {}), 40));
    },
    // Attach after the first fit so the scrollback replays at the real width.
    onOpen: () => {
      const { cols, rows } = handle.size();
      void core.sessionResize(id, cols, rows).catch(() => {});
      attach(id, handle);
    },
  });
  terms.set(id, handle);
  return handle;
}

export function focusTerminal(id = activeSession()) {
  if (id) terms.get(id)?.focus();
}

function disposeTerminal(id: string) {
  terms.get(id)?.dispose();
  terms.delete(id);
  inputQueues.delete(id);
}

// Terminals follow the theme; tokens change on the next frame.
createRoot(() => {
  createEffect(() => {
    theme();
    requestAnimationFrame(() => terms.forEach((t) => t.applyTheme()));
  });
});

// ── daemon events ──────────────────────────────────────────────────────────

function upsert(info: SessionInfo) {
  const i = all.findIndex((s) => s.id === info.id);
  const prev = i >= 0 ? all[i] : undefined;
  if (i >= 0) setAll(i, reconcile(info));
  else setAll(all.length, info);
  const becameWaiting = info.alive && info.status === "waiting" && prev?.status !== "waiting";
  const looking = focusedTerm() === info.id && document.hasFocus();
  if (becameWaiting && !looking) notify(`${displayName(info)}: aguardando você`, "warn", 8000);
}

function dropSession(id: string) {
  setAll((list) => list.filter((s) => s.id !== id));
  setLayout(panes.close(layout(), id));
  disposeTerminal(id);
}

/** Loads the list and the saved pane layout of the current workspace. */
export async function refresh() {
  let list: SessionInfo[];
  try {
    list = await core.sessionList();
    setConnected(true);
  } catch (e) {
    setConnected(false);
    notify(`sessiond: ${errorMessage(e)}`, "error", 8000);
    return;
  }
  setAll(reconcile(list, { key: "id" }));
  const ids = new Set(list.map((s) => s.id));
  for (const id of [...terms.keys()]) if (!ids.has(id)) disposeTerminal(id);

  const key = layoutKey();
  let l = key ? load<panes.Layout | null>(key, null) : null;
  if (!l?.panes?.length) {
    // First time here: open every live session of this workspace.
    l = here()
      .filter((s) => s.alive)
      .reduce((acc, s) => panes.show(acc, s.id), panes.emptyLayout());
  }
  setLayout(panes.prune(l, new Set(here().map((s) => s.id))));
}

let reconnecting = false;
async function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  setConnected(false);
  notify("sessiond desconectado; reconectando…", "warn");
  await new Promise((r) => setTimeout(r, 500));
  reconnecting = false;
  await refresh();
  if (!connected()) return;
  // Replay each open terminal from the daemon's history.
  for (const [id, t] of terms) {
    if (!t.opened) continue;
    t.reset();
    attach(id, t);
  }
}

let started = false;
export async function init() {
  if (started) return;
  started = true;
  await core.onSessionUpdate(upsert);
  await core.onSessionRemoved(dropSession);
  await core.onSessiondDown(() => void reconnect());
}

// ── actions ────────────────────────────────────────────────────────────────

/** Shows a session in the terminal area and focuses it. */
export async function focusSession(id: string) {
  setLayout(panes.show(layout(), id));
  setTerminalVisible(true);
  await terminal(id);
  requestAnimationFrame(() => focusTerminal(id));
}

export function activateTab(paneId: number, id: string) {
  const l = layout();
  setLayout({ focused: paneId, panes: l.panes.map((p) => (p.id === paneId ? { ...p, active: id } : p)) });
  requestAnimationFrame(() => focusTerminal(id));
}

export function focusPane(paneId: number) {
  if (layout().focused !== paneId) setLayout({ ...layout(), focused: paneId });
}

/** Hides a session's tab; the session keeps running in the daemon. */
export function hideTab(id = activeSession()) {
  if (!id) return;
  setLayout(panes.close(layout(), id));
}

export function cycleTab(delta: number) {
  setLayout(panes.cycle(layout(), delta));
  requestAnimationFrame(() => focusTerminal());
}

export function split(): string | void {
  const next = panes.split(layout());
  if (typeof next === "string") return next;
  setLayout(next);
  requestAnimationFrame(() => focusTerminal());
}

export function unsplit() {
  setLayout(panes.unsplit(layout()));
}

let lastSize = { cols: 120, rows: 32 };
export function rememberSize(cols: number, rows: number) {
  if (cols > 10 && rows > 3) lastSize = { cols, rows };
}

export async function create(req: Omit<NewSession, "cols" | "rows">): Promise<string | void> {
  if (!workspace()) return "abra uma pasta antes";
  try {
    const info = await core.sessionCreate({ ...req, ...lastSize });
    setConnected(true);
    upsert(info);
    await focusSession(info.id);
    notify(`${info.name} iniciada${info.branch ? ` em ${info.branch}` : ""}`);
  } catch (e) {
    const kind = errorKind(e);
    if (kind === "not_repo") return "--worktree pede um repositório git";
    return errorMessage(e);
  }
}

export async function kill(s: SessionInfo): Promise<string | void> {
  if (!s.alive) return `${s.name} já terminou`;
  try {
    await core.sessionKill(s.id);
  } catch (e) {
    return errorMessage(e);
  }
}

export async function rename(s: SessionInfo, name: string): Promise<string | void> {
  try {
    upsert(await core.sessionRename(s.id, name));
  } catch (e) {
    return errorMessage(e);
  }
}

/** Forgets a session, asking first whenever something would be lost. */
export async function remove(s: SessionInfo): Promise<string | void> {
  let removeWorktree = false;
  let force = false;
  try {
    if (s.worktree) {
      const dirty = await core.sessionWorktreeDirty(s.id);
      const choice = await confirm({
        title: `remover ${s.name}`,
        lines: [
          ...(s.alive ? [{ text: "a sessão ainda está rodando e será encerrada.", tone: "warn" as const }] : []),
          { text: `worktree: ${s.worktree}`, tone: "dim" },
          dirty
            ? { text: "o worktree tem mudanças não commitadas; removê-lo apaga essas mudanças.", tone: "danger" }
            : { text: `o branch ${s.branch ?? ""} fica no repositório.`, tone: "dim" },
        ],
        options: [
          { key: "w", label: "remover sessão e worktree", tone: dirty ? "danger" : "accent" },
          { key: "s", label: "só a sessão" },
          { key: "c", label: "cancelar" },
        ],
      });
      if (choice !== "w" && choice !== "s") return;
      removeWorktree = choice === "w";
      force = removeWorktree && dirty;
    } else if (s.alive) {
      const choice = await confirm({
        title: `remover ${s.name}`,
        lines: [{ text: "a sessão ainda está rodando e será encerrada.", tone: "warn" }],
        options: [
          { key: "r", label: "encerrar e remover", tone: "danger" },
          { key: "c", label: "cancelar" },
        ],
      });
      if (choice !== "r") return;
    }
    await core.sessionRemove(s.id, removeWorktree, force);
    dropSession(s.id);
    notify(removeWorktree ? `${s.name} e o worktree removidos` : `${s.name} removida`);
  } catch (e) {
    if (errorKind(e) === "dirty_worktree") return "o worktree ganhou mudanças; tente de novo";
    return errorMessage(e);
  }
}

/** `Mod+J`: toggles the terminal area, pointing at `:session new` when empty. */
export function toggleArea() {
  if (!hasTabs() && !here().length) {
    notify(":session new <agente> cria uma sessão (claude, codex, shell…)");
    return;
  }
  if (!hasTabs()) {
    const first = here().find((s) => s.alive) ?? here()[0];
    if (first) return void focusSession(first.id);
  }
  toggleTerminal();
}
