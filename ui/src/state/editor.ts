import { EditorSelection, EditorState, type StateEffect, type Text, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { getCM, Vim } from "@replit/codemirror-vim";
import { createEditorState, languageFor, languageSlot, vimExtension, vimSlot } from "../lib/editor-setup";
import { load, save } from "../lib/storage";
import { core, errorKind, errorMessage, type FsBatch } from "../lib/ipc";
import { detectEol, formatBytes, HIGHLIGHT_LIMIT_BYTES, type Eol } from "../lib/text";
import { baseName } from "../lib/tree";
import { notify } from "./ui";
import { reveal } from "./workspace";
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
export const [active, setActive] = createSignal<string | null>(null);
export const [cursor, setCursor] = createSignal({ line: 1, col: 1 });

export type VimMode = "normal" | "insert" | "visual" | "v-line" | "v-block" | "replace";
export const [vimEnabled, setVimEnabled] = createSignal(load("vim", true));
export const [vimMode, setVimMode] = createSignal<VimMode>("normal");

// Editor states live outside the reactive store: they are large and immutable.
const docs = new Map<string, DocSlot>();
let view: EditorView | null = null;
let pendingClose: string | null = null;

export function attachView(v: EditorView) {
  view = v;
}

/** Vim's adapter is recreated with each state, so listen again after a swap. */
function watchVimMode() {
  setVimMode("normal");
  const cm = view && getCM(view);
  cm?.on("vim-mode-change", (e: { mode: string; subMode?: string }) => {
    const sub = e.subMode === "linewise" ? "v-line" : e.subMode === "blockwise" ? "v-block" : null;
    setVimMode((e.mode === "visual" && sub) || (e.mode as VimMode));
  });
}

/** Turns vim keybindings on or off in every open buffer. */
export function setVim(on: boolean) {
  setVimEnabled(on);
  save("vim", on);
  for (const path of docs.keys()) applyToState(path, { effects: vimSlot.reconfigure(on ? vimExtension() : []) });
  watchVimMode();
}

/** Runs an ex command (`:%s/a/b/g`, `:42`) in the active buffer. False without one. */
export function vimEx(line: string): boolean {
  const cm = view && active() && vimEnabled() ? getCM(view) : null;
  if (!cm) return false;
  Vim.handleEx(cm as Parameters<typeof Vim.handleEx>[0], line.replace(/^:/, ""));
  view!.focus();
  return true;
}

export function focusEditor() {
  view?.focus();
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
  if (view && active() === path) return view.state;
  return docs.get(path)?.state;
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
  if (view && active() === path) view.dispatch(spec);
  else slot.state = slot.state.update(spec).state;
}

function stash() {
  const cur = active();
  const slot = cur ? docs.get(cur) : undefined;
  if (view && slot) {
    slot.state = view.state;
    slot.scroll = view.scrollSnapshot();
  }
}

export function activate(path: string, pos?: GotoPos) {
  const slot = docs.get(path);
  if (!slot || !view) return;
  if (active() !== path) {
    stash();
    view.setState(slot.state);
    watchVimMode();
    setActive(path);
    if (slot.scroll) view.dispatch({ effects: slot.scroll });
    const head = slot.state.selection.main.head;
    const line = slot.state.doc.lineAt(head);
    setCursor({ line: line.number, col: head - line.from + 1 });
    void reveal(path);
  }
  if (pos) goto(pos);
  view.focus();
}

function goto({ line, col = 1, length = 0 }: GotoPos) {
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
  const idx = tabs.findIndex((t) => t.path === path);
  const wasActive = active() === path;
  docs.delete(path);
  setTabs((list) => list.filter((t) => t.path !== path));
  if (wasActive) {
    setActive(null);
    const next = tabs[Math.min(idx, tabs.length - 1)];
    if (next) activate(next.path);
    else view?.setState(EditorState.create({ doc: "" }));
  }
}

export function cycleTab(delta: number) {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.path === active());
  const next = tabs[(idx + delta + tabs.length) % tabs.length];
  activate(next.path);
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
