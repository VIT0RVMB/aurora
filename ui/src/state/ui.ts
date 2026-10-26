import { createSignal } from "solid-js";
import { load, save } from "../lib/storage";

export type PaletteMode = "files" | "command";
export type RightPanel = "sessions" | "search";

export const [palette, setPalette] = createSignal<{ mode: PaletteMode; initial: string } | null>(null);

export function openPalette(mode: PaletteMode, initial = mode === "command" ? ":" : "") {
  setPalette({ mode, initial });
}

export const [prefsOpen, setPrefsOpen] = createSignal(false);

/**
 * What the editor area shows: the open file ("auto", or home with no file),
 * or a view asked for with `:home` / `:kanban`. Opening a file goes back to auto.
 */
export type CenterView = "auto" | "home" | "kanban" | "diff" | "history";
export const [centerView, setCenterView] = createSignal<CenterView>("auto");
/** Session whose changes the diff view shows. */
export const [diffSession, setDiffSession] = createSignal<string | null>(null);

/**
 * `work`: editor (or a view) with the terminals docked beside it. `sessions`:
 * the terminals alone, optionally sharing the center with the board.
 */
export type Mode = "work" | "sessions";
export const [mode, setMode] = createSignal<Mode>("work");

export function goHome() {
  setMode("work");
  setCenterView("home");
}

export function openDiff(id: string) {
  setMode("work");
  setDiffSession(id);
  setCenterView("diff");
}

/** Closes a view that took the editor area (changes, history, board). False if none is open. */
export function closeView(): boolean {
  const v = centerView();
  if (v !== "diff" && v !== "history" && v !== "kanban") return false;
  setCenterView("auto");
  return true;
}

/** Workspace file whose git history the history view shows. */
export const [historyPath, setHistoryPath] = createSignal<string | null>(null);

export function openHistory(path: string) {
  setMode("work");
  setHistoryPath(path);
  setCenterView("history");
}

/** Wall clock for "5m ago" columns; ticks every 30 s. */
const [now, setNow] = createSignal(Date.now());
setInterval(() => setNow(Date.now()), 30_000);
export { now };

/** Where the keyboard is; drives the mode badge and the hint bar. */
export type Area = "editor" | "terminal" | "tree" | "panel" | "board" | "none";
export const [area, setAreaSignal] = createSignal<Area>("none");
/** Editor or terminal, whichever had the keyboard last: what `:split` acts on. */
export const [workArea, setWorkArea] = createSignal<"editor" | "terminal">("editor");

export function setArea(a: Area) {
  setAreaSignal(a);
  if (a === "editor" || a === "terminal") setWorkArea(a);
}

export function areaOf(el: Element | null): Area {
  if (!el?.closest) return "none";
  if (el.closest(".term-host")) return "terminal";
  if (el.closest(".kanban")) return "board";
  if (el.closest(".editor-host")) return "editor";
  if (el.closest(".tree")) return "tree";
  if (el.closest(".right")) return "panel";
  return "none";
}

export const [treeVisible, setTreeVisible] = createSignal(load("treeVisible", true));
export const [rightVisible, setRightVisible] = createSignal(load("rightVisible", false));
export const [treeCells, setTreeCells] = createSignal(load("treeCells", 32));
export const [rightCells, setRightCells] = createSignal(load("rightCells", 48));
export const [rightTab, setRightTabSignal] = createSignal<RightPanel>(load("rightTab", "sessions"));
export const [terminalVisible, setTerminalVisible] = createSignal(load("terminalVisible", true));
/** Height of the terminal area when it shares the column with the editor. */
export const [terminalRows, setTerminalRows] = createSignal(load("terminalRows", 16));
/** Width of the terminal area when it sits beside the editor. */
export const [terminalCols, setTerminalCols] = createSignal(load("terminalCols", 90));

/** Which side of the editor the terminal area sits on. */
export type Dock = "bottom" | "top" | "left" | "right";
export const DOCKS: Dock[] = ["bottom", "right", "left", "top"];
export const [dock, setDockSignal] = createSignal<Dock>(load<Dock>("dock", "bottom"));

export function setDock(d: Dock) {
  setDockSignal(d);
  save("dock", d);
}

export function showRight(tab: RightPanel) {
  setRightTabSignal(tab);
  save("rightTab", tab);
  toggleRight(true);
}

export function toggleTerminal(v = !terminalVisible()) {
  setTerminalVisible(v);
  save("terminalVisible", v);
}

export function toggleTree(v = !treeVisible()) {
  setTreeVisible(v);
  save("treeVisible", v);
}

export function toggleRight(v = !rightVisible()) {
  setRightVisible(v);
  save("rightVisible", v);
}

export function persistSizes() {
  save("treeCells", treeCells());
  save("rightCells", rightCells());
  save("terminalRows", terminalRows());
  save("terminalCols", terminalCols());
}

/** One-line message in the status bar; replaced by the next one. */
export type Tone = "info" | "warn" | "error";
const [message, setMessage] = createSignal<{ text: string; tone: Tone } | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

export { message };

export function notify(text: string, tone: Tone = "info", ms = 4000) {
  setMessage({ text, tone });
  clearTimeout(timer);
  timer = setTimeout(() => setMessage(null), ms);
}

/** Bumped to ask the search panel to focus its input. */
export const [searchFocus, setSearchFocus] = createSignal(0);
export const [treeFocus, setTreeFocus] = createSignal(0);

export interface ConfirmOption {
  /** Single key that picks the option. */
  key: string;
  label: string;
  tone?: "danger" | "accent";
}

export interface ConfirmRequest {
  title: string;
  lines: { text: string; tone?: "warn" | "danger" | "dim" }[];
  options: ConfirmOption[];
  resolve: (key: string | null) => void;
}

export const [confirmation, setConfirmation] = createSignal<ConfirmRequest | null>(null);

// ── context menu and text prompt ────────────────────────────────────────────

export type MenuItem =
  | { label: string; run: () => void; tone?: "danger"; hint?: string }
  | { separator: true }
  /** A row of color swatches; `null` clears. */
  | { colors: string[]; current: string | null; pick: (c: string | null) => void };

export interface MenuRequest {
  x: number;
  y: number;
  title?: string;
  items: MenuItem[];
}

export const [menu, setMenu] = createSignal<MenuRequest | null>(null);

/** Opens a right-click menu at the pointer. */
export function openMenu(e: MouseEvent, items: MenuItem[], title?: string) {
  e.preventDefault();
  e.stopPropagation();
  setMenu({ x: e.clientX, y: e.clientY, items, title });
}

export interface PromptRequest {
  title: string;
  value: string;
  /** Part of `value` selected at first (a file name without its extension). */
  select?: [number, number];
  resolve: (v: string | null) => void;
}

export const [prompt, setPrompt] = createSignal<PromptRequest | null>(null);

/** Asks for one line of text; null on Esc. */
export function ask(req: Omit<PromptRequest, "resolve">): Promise<string | null> {
  prompt()?.resolve(null);
  return new Promise((resolve) =>
    setPrompt({
      ...req,
      resolve: (v) => {
        setPrompt(null);
        resolve(v);
      },
    }),
  );
}

/** Modal question; resolves to the chosen option's key, or null on Esc. */
export function confirm(req: Omit<ConfirmRequest, "resolve">): Promise<string | null> {
  confirmation()?.resolve(null);
  return new Promise((resolve) =>
    setConfirmation({
      ...req,
      resolve: (k) => {
        setConfirmation(null);
        resolve(k);
      },
    }),
  );
}
