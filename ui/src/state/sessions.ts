import { Channel } from "@tauri-apps/api/core";
import { createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { core, errorKind, errorMessage, type NewSession, type SessionInfo, type Stage } from "../lib/ipc";
import * as panes from "../lib/panes";
import { displayName, sameFolder, sortSessions } from "../lib/sessions";
import { load, save } from "../lib/storage";
import type { TermHandle } from "../lib/terminal";
import { bgOpacity, fontKey, termScroll } from "./prefs";
import { variant } from "./theme";
import type { DropTarget } from "./drag";
import { confirm, dock, notify, setDock, setTerminalVisible, toggleTerminal } from "./ui";
import { workspace } from "./workspace";
import { t } from "../lib/i18n";

/** Every session the daemon knows, from all workspaces. */
export const [all, setAll] = createStore<SessionInfo[]>([]);
export const [layout, setLayoutSignal] = createSignal<panes.Layout>(panes.emptyLayout());
/** null until the first connection attempt finishes. */
export const [connected, setConnected] = createSignal<boolean | null>(null);
/** Session whose terminal has keyboard focus, if any. */
export const [focusedTerm, setFocusedTerm] = createSignal<string | null>(null);

const { here, archived, waiting } = createRoot(() => {
  const ofWorkspace = createMemo(() => {
    const root = workspace()?.root;
    return root ? sortSessions(all.filter((s) => sameFolder(s.workspace, root))) : [];
  });
  const here = createMemo(() => ofWorkspace().filter((s) => !s.archived));
  const archived = createMemo(() => ofWorkspace().filter((s) => s.archived));
  const waiting = createMemo(() => here().filter((s) => s.alive && s.status === "waiting").length);
  return { here, archived, waiting };
});
/** Sessions of the open workspace, the ones needing you first; archived ones apart. */
export { here, archived, waiting };

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
    scrollSpeed: termScroll(),
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
    variant();
    bgOpacity();
    requestAnimationFrame(() => terms.forEach((t) => t.applyTheme()));
  });
  createEffect(() => {
    fontKey();
    requestAnimationFrame(() => terms.forEach((t) => t.applyFont()));
  });
  createEffect(() => {
    const n = termScroll();
    terms.forEach((t) => t.setScrollSpeed(n));
  });
});

// ── daemon events ──────────────────────────────────────────────────────────

function upsert(info: SessionInfo) {
  const i = all.findIndex((s) => s.id === info.id);
  const prev = i >= 0 ? all[i] : undefined;
  if (i >= 0) setAll(i, reconcile(info));
  else setAll(all.length, info);
  // Archived (here or from another window): its tab goes away, the session stays.
  if (info.archived && panes.paneOf(layout(), info.id)) setLayout(panes.close(layout(), info.id));
  // Ended (killed, or the agent exited): its tab closes; the panel still opens it.
  if (prev?.alive && !info.alive) {
    if (panes.paneOf(layout(), info.id)) setLayout(panes.close(layout(), info.id));
    const name = displayName(info);
    if (info.exitCode) notify(t("sess.endedCode", { name, code: info.exitCode }), "warn", 8000);
    else notify(t("sess.ended", { name }));
  }
  const becameWaiting = info.alive && info.status === "waiting" && prev?.status !== "waiting";
  const looking = focusedTerm() === info.id && document.hasFocus();
  if (becameWaiting && !looking) notify(t("sess.waiting", { name: displayName(info) }), "warn", 8000);
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
  // Sessions that ended while the app was closed lose their tabs too.
  setLayout(panes.prune(l, new Set(here().filter((s) => s.alive).map((s) => s.id))));
}

let reconnecting = false;
async function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  setConnected(false);
  notify(t("sess.disconnected"), "warn");
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
  setLayout({ ...l, focused: paneId, panes: l.panes.map((p) => (p.id === paneId ? { ...p, active: id } : p)) });
  requestAnimationFrame(() => focusTerminal(id));
}

export function focusPane(paneId: number) {
  if (layout().focused !== paneId) setLayout(panes.focus(layout(), paneId));
}

/** Focuses the next (or previous) terminal pane. */
export function focusNextPane(delta = 1) {
  setLayout(panes.focusPane(layout(), delta));
  requestAnimationFrame(() => focusTerminal());
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

/** Moves the active session into a new pane beside (`row`) or below (`column`) it. */
export function split(dir: panes.Dir = "row"): string | void {
  const next = panes.split(layout(), dir);
  if (!next) return t("sess.paneNeedsTwo");
  setLayout(next);
  requestAnimationFrame(() => focusTerminal());
}

export function unsplit() {
  setLayout(panes.unsplit(layout()));
}

/** A dragged session tab: a slot in a tab strip, or a pane's middle or edge. */
export function canDropTab(id: string, t: DropTarget): boolean {
  if (t.dock) return t.dock !== dock();
  return t.index != null || panes.canDrop(layout(), id, t.pane, t.side!);
}

export function dropTab(id: string, t: DropTarget) {
  if (t.dock) return setDock(t.dock);
  const l = layout();
  setLayout(t.index != null ? panes.move(l, id, t.pane, t.index) : panes.drop(l, id, t.pane, t.side!));
  requestAnimationFrame(() => focusTerminal(id));
}

export function resizePanes(path: number[], sizes: number[]) {
  setLayout(panes.resize(layout(), path, sizes));
}

let lastSize = { cols: 120, rows: 32 };
export function rememberSize(cols: number, rows: number) {
  if (cols > 10 && rows > 3) lastSize = { cols, rows };
}

export async function create(req: Omit<NewSession, "cols" | "rows">): Promise<string | void> {
  if (!workspace()) return t("err.openFolderFirst");
  try {
    const info = await core.sessionCreate({ ...req, ...lastSize });
    setConnected(true);
    upsert(info);
    await focusSession(info.id);
    notify(info.branch ? t("sess.startedOn", { name: info.name, branch: info.branch }) : t("sess.started", { name: info.name }));
  } catch (e) {
    const kind = errorKind(e);
    if (kind === "not_repo") return t("sess.needsRepo");
    return errorMessage(e);
  }
}

export async function kill(s: SessionInfo): Promise<string | void> {
  if (!s.alive) return t("sess.alreadyEnded", { name: s.name });
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

/** Label color for telling sessions apart; null clears it. */
export async function setColor(s: SessionInfo, color: string | null): Promise<string | void> {
  upsert({ ...s, color });
  try {
    upsert(await core.sessionSetColor(s.id, color));
  } catch (e) {
    upsert(s);
    return errorMessage(e);
  }
}

/** Archiving takes a session out of tabs, lists and the board; it keeps running if alive. */
export async function setArchived(s: SessionInfo, archived: boolean): Promise<string | void> {
  try {
    upsert(await core.sessionSetArchived(s.id, archived));
  } catch (e) {
    return errorMessage(e);
  }
  notify(t(archived ? "sess.archived" : "sess.unarchived", { name: displayName(s) }));
}

export async function setStage(s: SessionInfo, stage: Stage): Promise<string | void> {
  if (s.stage === stage) return;
  upsert({ ...s, stage }); // the board moves now; the daemon confirms
  try {
    upsert(await core.sessionSetStage(s.id, stage));
  } catch (e) {
    upsert(s);
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
        title: t("sess.removeTitle", { name: s.name }),
        lines: [
          ...(s.alive ? [{ text: t("sess.stillRunning"), tone: "warn" as const }] : []),
          { text: `worktree: ${s.worktree}`, tone: "dim" },
          dirty
            ? { text: t("sess.dirtyWorktree"), tone: "danger" }
            : { text: t("sess.branchStays", { branch: s.branch ?? "" }), tone: "dim" },
        ],
        options: [
          { key: "w", label: t("sess.removeBoth"), tone: dirty ? "danger" : "accent" },
          { key: "s", label: t("sess.onlySession") },
          { key: "c", label: t("cancel") },
        ],
      });
      if (choice !== "w" && choice !== "s") return;
      removeWorktree = choice === "w";
      force = removeWorktree && dirty;
    } else if (s.alive) {
      const choice = await confirm({
        title: t("sess.removeTitle", { name: s.name }),
        lines: [{ text: t("sess.stillRunning"), tone: "warn" }],
        options: [
          { key: "r", label: t("sess.stopRemove"), tone: "danger" },
          { key: "c", label: t("cancel") },
        ],
      });
      if (choice !== "r") return;
    }
    await core.sessionRemove(s.id, removeWorktree, force);
    dropSession(s.id);
    notify(t(removeWorktree ? "sess.removedBoth" : "sess.removed", { name: s.name }));
  } catch (e) {
    if (errorKind(e) === "dirty_worktree") return t("sess.worktreeChanged");
    return errorMessage(e);
  }
}

/** `Mod+J`: toggles the terminal area, pointing at `:session new` when empty. */
export function toggleArea() {
  if (!hasTabs() && !here().length) {
    notify(t("sess.newHint"));
    return;
  }
  if (!hasTabs()) {
    const first = here().find((s) => s.alive) ?? here()[0];
    if (first) return void focusSession(first.id);
  }
  toggleTerminal();
}
