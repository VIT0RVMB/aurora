import { createSignal } from "solid-js";
import { load, save } from "../lib/storage";

export type PaletteMode = "files" | "command";
export type RightPanel = "sessions" | "search";

export const [palette, setPalette] = createSignal<{ mode: PaletteMode; initial: string } | null>(null);

export function openPalette(mode: PaletteMode, initial = mode === "command" ? ":" : "") {
  setPalette({ mode, initial });
}

export const [prefsOpen, setPrefsOpen] = createSignal(false);

/** Where the keyboard is; drives the mode badge and the hint bar. */
export type Area = "editor" | "terminal" | "tree" | "panel" | "none";
export const [area, setArea] = createSignal<Area>("none");

export function areaOf(el: Element | null): Area {
  if (!el?.closest) return "none";
  if (el.closest(".term-host")) return "terminal";
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
