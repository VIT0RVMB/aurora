import { createSignal } from "solid-js";
import { t } from "../lib/i18n";
import { load, save } from "../lib/storage";

/** Monospace fonts offered in preferences; any other installed family can be typed. */
export const FONT_CHOICES = [
  "JetBrains Mono",
  "ui-monospace",
  "Menlo",
  "Monaco",
  "Berkeley Mono",
  "Fira Code",
  "Cascadia Code",
  "Source Code Pro",
  "IBM Plex Mono",
  "Hack",
  "Iosevka",
  "Courier New",
];

/** What a family is called in the list; `ui-monospace` is the system font. */
export function fontLabel(family: string): string {
  return family === "ui-monospace" ? t("prefs.system") : family;
}

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 24;
const DEFAULT_SIZE = 13;

// Everything is laid out on the cell grid, so rows scale with the font
// (13px text on 20px rows, the original look).
export const cellHeight = (size: number) => Math.round((size * 20) / 13);

const STACK_TAIL = `"SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace`;

function stack(family: string): string {
  return family === "ui-monospace" ? `ui-monospace, ${STACK_TAIL}` : `"${family.replace(/"/g, "")}", ${STACK_TAIL}`;
}

/** Whether the system has `family`: its text measures differently from the fallbacks'. */
export function fontInstalled(family: string): boolean {
  if (family === "ui-monospace") return true;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return true;
  const text = "mmmmmmmmmwwwwwlli10O";
  return ["monospace", "serif"].some((base) => {
    ctx.font = `40px ${base}`;
    const a = ctx.measureText(text).width;
    ctx.font = `40px "${family}", ${base}`;
    return ctx.measureText(text).width !== a;
  });
}

/** `null`: the default stack from tokens.css. */
const [fontFamily, setFontFamilySignal] = createSignal<string | null>(load<string | null>("fontFamily", null));
const [fontSize, setFontSizeSignal] = createSignal<number>(load("fontSize", DEFAULT_SIZE));

export { fontFamily, fontSize };

function apply() {
  const root = document.documentElement.style;
  const family = fontFamily();
  if (family) root.setProperty("--font-mono", stack(family));
  else root.removeProperty("--font-mono");
  root.setProperty("--font-size", `${fontSize()}px`);
  root.setProperty("--cell-h", `${cellHeight(fontSize())}px`);
}
apply();

export function setFontFamily(family: string | null) {
  const f = family?.trim() || null;
  setFontFamilySignal(f);
  save("fontFamily", f);
  apply();
}

export function setFontSize(size: number) {
  const s = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)));
  setFontSizeSignal(s);
  save("fontSize", s);
  apply();
}

/** Bumped on every font change; terminals and cell measurements follow it. */
export const fontKey = () => `${fontFamily() ?? ""}|${fontSize()}`;
