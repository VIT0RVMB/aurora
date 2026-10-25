import { EditorSelection, EditorState, type StateEffect, type Text, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { getCM, Vim } from "@replit/codemirror-vim";
import { createEditorState, languageFor, languageSlot, vimExtension, vimSlot } from "../lib/editor-setup";
import { load, save } from "../lib/storage";
import { core, errorKind, errorMessage, type FsBatch } from "../lib/ipc";
import { detectEol, formatBytes, HIGHLIGHT_LIMIT_BYTES, type Eol } from "../lib/text";
import * as panes from "../lib/panes";
import { baseName } from "../lib/tree";
import { notify, openPalette, setCenterView } from "./ui";
import { reveal, workspace } from "./workspace";
import { t } from "../lib/i18n";

export interface Tab {
  path: string;
  name: string;
  dirty: boolean;
  /** Disk diverged from the editor while it had unsaved edits, or the file is gone. */
  conflict: "changed" | "deleted" | null;
  mtime: number;
  size: number;
  eol: Eol;
  language: string | null;
  /** Opened without highlighting because of its size. */
  plain: boolean;
}

interface DocSlot {
  state: EditorState;
  saved: Text;
  scroll?: StateEffect<unknown>;
}

export const [tabs, setTabs] = createStore<Tab[]>([]);
/**
 * Editor groups: splits of the editor area, each with its own tabs and view.
 * A file sits in one group at a time; `tabs` holds what every open file is.
 */
export const [groups, setGroupsSignal] = createSignal<panes.Layout>(panes.emptyLayout());
/** The focused group's file. */
export const active = () => panes.focusedPane(groups()).active;
export const [cursor, setCursor] = createSignal({ line: 1, col: 1 });

export type VimMode = "normal" | "insert" | "visual" | "v-line" | "v-block" | "replace";
export const [vimEnabled, setVimEnabled] = createSignal(load("vim", true));
export const [vimMode, setVimMode] = createSignal<VimMode>("normal");

// Editor states live outside the reactive store: they are large and immutable.
// A file shown in a group lives in that group's view; `docs` holds the rest
// (and a stale copy of the shown ones, refreshed whenever they leave a view).
const docs = new Map<string, DocSlot>();
const views = new Map<number, EditorView>();
/** What each view displays right now. */
const shownIn = new Map<number, string | null>();
let pendingClose: string | null = null;

/** The focused group's view. */
const view = () => views.get(groups().focused) ?? null;

function viewOf(path: string): EditorView | null {
  for (const [id, p] of shownIn) if (p === path) return views.get(id) ?? null;
  return null;
}

function wantedIn(l: panes.Layout, id: number): string | null {
  return l.panes.find((p) => p.id === id)?.active ?? null;
}

/**
 * Applies a new group layout. Views about to show something else hand their
 * state back to `docs` first: a group that disappears unmounts its view
 * while the layout is being set.
 */
function setGroups(l: panes.Layout) {
  for (const [id, v] of views) {
    const cur = shownIn.get(id) ?? null;
    if (cur === wantedIn(l, id)) continue;
    const slot = cur ? docs.get(cur) : undefined;
    if (slot) {
      slot.state = v.state;
      slot.scroll = v.scrollSnapshot();
    }
    shownIn.delete(id);
  }
  setGroupsSignal(l);
  for (const id of views.keys()) showGroup(id);
}

/** Puts the group's file into its view, if it is not there already. */
function showGroup(id: number) {
  const v = views.get(id);
  if (!v) return;
  const want = wantedIn(groups(), id);
  if (shownIn.has(id) && shownIn.get(id) === want) return;
  shownIn.set(id, want);
  const slot = want ? docs.get(want) : undefined;
  v.setState(slot?.state ?? EditorState.create({ doc: "" }));
  if (slot?.scroll) v.dispatch({ effects: slot.scroll });
  watchVimMode(id);
}

/** A group's view was created; it shows the group's file. */
export function attachView(id: number, v: EditorView) {
  views.set(id, v);
  shownIn.delete(id);
  showGroup(id);
}

export function detachView(id: number) {
  const v = views.get(id);
  const cur = shownIn.get(id);
  const slot = cur ? docs.get(cur) : undefined;
  if (v && slot) slot.state = v.state;
  views.delete(id);
  shownIn.delete(id);
  v?.destroy();
}

/** Vim's adapter is recreated with each state, so listen again after a swap. */
function watchVimMode(id: number) {
  const v = views.get(id);
  if (id === groups().focused) setVimMode("normal");
  const cm = v && getCM(v);
  cm?.on("vim-mode-change", (e: { mode: string; subMode?: string }) => {
    if (id !== groups().focused) return;
    const sub = e.subMode === "linewise" ? "v-line" : e.subMode === "blockwise" ? "v-block" : null;
    setVimMode((e.mode === "visual" && sub) || (e.mode as VimMode));
  });
}

/** A click or focus inside a group makes it the one commands act on. */
export function focusGroup(id: number) {
  if (groups().focused === id) return;
  setGroupsSignal(panes.focus(groups(), id));
  setVimMode("normal");
  syncCursor();
}

function syncCursor() {
  const st = view()?.state;
  if (!st) return;
  const head = st.selection.main.head;
  const line = st.doc.lineAt(head);
  setCursor({ line: line.number, col: head - line.from + 1 });
}

/** Turns vim keybindings on or off in every open buffer. */
export function setVim(on: boolean) {
  setVimEnabled(on);
  save("vim", on);
  for (const path of docs.keys()) applyToState(path, { effects: vimSlot.reconfigure(on ? vimExtension() : []) });
  for (const id of views.keys()) watchVimMode(id);
}

/** Runs an ex command (`:%s/a/b/g`, `:42`) in the active buffer. False without one. */
export function vimEx(line: string): boolean {
  const v = view();
  const cm = v && active() && vimEnabled() ? getCM(v) : null;
  if (!cm) return false;
  Vim.handleEx(cm as Parameters<typeof Vim.handleEx>[0], line.replace(/^:/, ""));
  v!.focus();
  return true;
}

export function focusEditor() {
  view()?.focus();
}

export function activeTab(): Tab | undefined {
  const p = active();
  return tabs.find((t) => t.path === p);
}

function updateTab(path: string, fn: (t: Tab) => void) {
  setTabs(
    (t) => t.path === path,
    produce((t) => fn(t)),
  );
}

function currentState(path: string): EditorState | undefined {
  return viewOf(path)?.state ?? docs.get(path)?.state;
}

function refreshDirty(path: string) {
  const slot = docs.get(path);
  const st = currentState(path);
  if (!slot || !st) return;
  const dirty = !st.doc.eq(slot.saved);
  const tab = tabs.find((t) => t.path === path);
  if (tab && tab.dirty !== dirty) updateTab(path, (t) => (t.dirty = dirty));
}

export interface GotoPos {
  line: number;
  /** 1-based, in UTF-16 units. */
  col?: number;
  length?: number;
}

export async function openFile(path: string, pos?: GotoPos) {
  if (!docs.has(path)) {
    let file;
    try {
      file = await core.readFile(path);
    } catch (e) {
      const kind = errorKind(e);
      const why = kind === "binary" ? t("editor.binary") : kind === "not_utf8" ? t("editor.notUtf8") : errorMessage(e);
      notify(`${path}: ${why}`, "warn");
      return;
    }
    if (docs.has(path)) return activate(path, pos); // opened twice concurrently
    const eol = detectEol(file.content);
    const plain = file.stat.size > HIGHLIGHT_LIMIT_BYTES;
    const lang = plain ? null : languageFor(path);
    const state = createEditorState({
      doc: file.content,
      vim: vimEnabled(),
      crlf: eol === "crlf",
      onChange: () => refreshDirty(path),
      onCursor: (line, col) => setCursor({ line, col }),
    });
    docs.set(path, { state, saved: state.doc });
    setTabs(tabs.length, {
      path,
      name: baseName(path),
      dirty: false,
      conflict: null,
      mtime: file.stat.mtimeMs,
      size: file.stat.size,
      eol,
      language: lang?.name ?? null,
      plain,
    });
    if (plain) notify(t("editor.plain", { name: baseName(path), size: formatBytes(file.stat.size) }), "info");
    if (lang) void lang.load().then((support) => applyToState(path, { effects: languageSlot.reconfigure(support) }));
  }
  activate(path, pos);
}

function applyToState(path: string, spec: TransactionSpec) {
  const slot = docs.get(path);
  if (!slot) return;
  const v = viewOf(path);
  if (v) v.dispatch(spec);
  else slot.state = slot.state.update(spec).state;
}

/** Files opened lately in this workspace, newest first (the home screen lists them). */
export interface RecentFile {
  path: string;
  at: number;
}
const [recentFiles, setRecentFiles] = createSignal<RecentFile[]>([]);
export { recentFiles };
const recentKey = () => (workspace() ? `recentFiles:${workspace()!.root}` : null);
createRoot(() =>
  createEffect(
    on(recentKey, (k) => setRecentFiles(k ? load<RecentFile[]>(k, []) : [])),
  ),
);

function rememberFile(path: string) {
  const k = recentKey();
  if (!k) return;
  const next = [{ path, at: Date.now() }, ...recentFiles().filter((r) => r.path !== path)].slice(0, 12);
  setRecentFiles(next);
  save(k, next);
}

/** Shows a file: in its group if it has one, else in the focused group. */
export function activate(path: string, pos?: GotoPos) {
  if (!docs.has(path)) return;
  setCenterView("auto");
  if (active() !== path) {
    setGroups(panes.show(groups(), path));
    rememberFile(path);
    syncCursor();
    void reveal(path);
  }
  if (pos) goto(pos);
  view()?.focus();
}

function goto({ line, col = 1, length = 0 }: GotoPos) {
  const view = viewOf(active() ?? "");
  if (!view) return;
  const doc = view.state.doc;
  const l = doc.line(Math.min(Math.max(line, 1), doc.lines));
  const from = Math.min(l.from + col - 1, l.to);
  const to = Math.min(from + length, l.to);
  view.dispatch({
    selection: EditorSelection.single(from, to),
    effects: EditorView.scrollIntoView(from, { y: "center" }),
  });
}

/** Closes a tab. A dirty tab needs a second request (or `force`) to discard edits. */
export function closeTab(path = active(), force = false) {
  if (!path) return;
  const tab = tabs.find((t) => t.path === path);
  if (!tab) return;
  if (tab.dirty && !force && pendingClose !== path) {
    pendingClose = path;
    notify(t("editor.closeAgain", { name: tab.name }), "warn");
    return;
  }
  pendingClose = null;
  const wasActive = active() === path;
  docs.delete(path);
  setTabs((list) => list.filter((t) => t.path !== path));
  // Its group shows the neighbouring tab; an emptied group closes.
  setGroups(panes.close(groups(), path));
  const next = active();
  if (wasActive && next) {
    rememberFile(next);
    syncCursor();
    void reveal(next);
    view()?.focus();
  }
}

/** Next/previous tab inside the focused group. */
export function cycleTab(delta: number) {
  const g = panes.focusedPane(groups());
  if (g.tabs.length < 2 || !g.active) return;
  const i = g.tabs.indexOf(g.active);
  activate(g.tabs[(i + delta + g.tabs.length) % g.tabs.length]);
}

/**
 * Splits the editor: the active file moves to a new group beside (`row`) or
 * below (`column`) it. With one file there the new group starts empty and
 * the file picker opens to fill it.
 */
export function split(dir: panes.Dir = "row") {
  const g = panes.focusedPane(groups());
  setCenterView("auto");
  setGroups(panes.split(groups(), dir, true)!);
  const id = groups().focused;
  // After the frame: a palette that ran this hands focus back to the old group first.
  requestAnimationFrame(() => {
    focusGroup(id);
    if (g.tabs.length < 2) openPalette("files");
    else view()?.focus();
  });
}

/** Folds every editor group back into one. */
export function unsplit() {
  setGroups(panes.unsplit(groups()));
}

export function focusNextGroup(delta = 1) {
  const l = panes.focusPane(groups(), delta);
  focusGroup(l.focused);
  view()?.focus();
}

/** Closes the focused group when it has no files (a split nothing was opened in). */
export function closeEmptyGroup(): boolean {
  const l = groups();
  const g = panes.focusedPane(l);
  if (g.tabs.length > 0 || l.panes.length < 2) return false;
  const at = l.panes.indexOf(g);
  const rest = l.panes.filter((p) => p !== g);
  setGroups({ ...l, panes: rest, focused: rest[Math.max(0, at - 1)].id });
  view()?.focus();
  return true;
}

export async function saveFile(path = active()) {
  if (!path) return;
  const slot = docs.get(path);
  const st = currentState(path);
  if (!slot || !st) return;
  try {
    // sliceDoc joins lines with the state's own separator, so CRLF survives.
    const stat = await core.writeFile(path, st.sliceDoc());
    slot.saved = st.doc;
    updateTab(path, (t) => {
      t.mtime = stat.mtimeMs;
      t.size = stat.size;
      t.conflict = null;
    });
    refreshDirty(path);
    pendingClose = null;
  } catch (e) {
    notify(t("editor.saveFailed", { path, err: errorMessage(e) }), "error");
  }
}

/** Replaces the buffer with what is on disk, discarding unsaved edits. */
export async function reloadFromDisk(path: string) {
  const slot = docs.get(path);
  const st = currentState(path);
  if (!slot || !st) return;
  try {
    const file = await core.readFile(path);
    applyToState(path, { changes: { from: 0, to: st.doc.length, insert: file.content } });
    const fresh = currentState(path)!;
    slot.saved = fresh.doc;
    updateTab(path, (t) => {
      t.mtime = file.stat.mtimeMs;
      t.size = file.stat.size;
      t.conflict = null;
    });
    refreshDirty(path);
  } catch (e) {
    notify(t("editor.reloadFailed", { path, err: errorMessage(e) }), "error");
  }
}

/** Keeps the editor's version; the next save overwrites the disk. */
export function keepMine(path: string) {
  updateTab(path, (t) => (t.conflict = null));
}

/** Reacts to disk changes for open tabs: silent reload when clean, conflict when dirty. */
export async function applyFsBatch(b: FsBatch) {
  const changed = new Set(b.changed);
  const affected = tabs.filter((t) => b.rescan || changed.has(t.path)).map((t) => t.path);
  for (const path of affected) {
    let mtime: number;
    try {
      mtime = (await core.statFile(path)).mtimeMs;
    } catch (e) {
      if (errorKind(e) === "not_found") updateTab(path, (t) => (t.conflict = "deleted"));
      continue;
    }
    const tab = tabs.find((t) => t.path === path);
    if (!tab || mtime === tab.mtime) continue; // our own save, or nothing new
    if (tab.dirty) updateTab(path, (t) => (t.conflict = "changed"));
    else await reloadFromDisk(path);
  }
}

export function hasDirtyTabs(): boolean {
  return tabs.some((t) => t.dirty);
}
