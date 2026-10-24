import { createSignal } from "solid-js";
import { core, errorMessage, type ThemeInfo, type ThemeTokens } from "../lib/ipc";
import { load, save } from "../lib/storage";

/** `dark` (phosphor) and `light` live in tokens.css; any other id is a scheme file. */
export type Theme = string;
const BUILTIN_THEMES = ["dark", "light"] as const;

const isBuiltin = (id: string) => (BUILTIN_THEMES as readonly string[]).includes(id);

const [theme, setThemeSignal] = createSignal<Theme>("dark");
const [themes, setThemes] = createSignal<ThemeInfo[]>([]);
const [themesDir, setThemesDir] = createSignal("");

export { theme, themes, themesDir };

let applied: string[] = [];

function apply(id: string, variant: "dark" | "light", tokens: Record<string, string> = {}) {
  const root = document.documentElement;
  for (const k of applied) root.style.removeProperty(k);
  applied = Object.keys(tokens);
  for (const k of applied) root.style.setProperty(k, tokens[k]);
  root.dataset.theme = variant;
  setThemeSignal(id);
}

// Phosphor (dark) is the look of the app. A scheme's tokens are cached so it
// paints on the first frame; the core refreshes them right after.
const initial = load<Theme>("theme", "dark");
const cached = load<ThemeTokens | null>("theme-tokens", null);
if (isBuiltin(initial)) apply(initial, initial as "dark" | "light");
else if (cached?.id === initial) apply(initial, cached.variant, cached.tokens);
else apply("dark", "dark");

/** Re-reads the saved scheme and the list from the core; called once the core is reachable. */
export async function syncTheme(): Promise<void> {
  if (!isBuiltin(initial) && (await setTheme(initial))) await setTheme("dark");
  await refreshThemes();
}

/** Reloads the list of schemes from the themes folder. */
export async function refreshThemes(): Promise<void> {
  try {
    const l = await core.listThemes();
    setThemes(l.themes);
    setThemesDir(l.dir);
  } catch {
    // No list: completion just offers the built-ins.
  }
}

/** Switches theme; resolves to an error message, if any. */
export async function setTheme(next: Theme | "toggle"): Promise<string | void> {
  if (next === "toggle") {
    const variant = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    next = variant === "dark" ? "light" : "dark";
  }
  if (isBuiltin(next)) {
    apply(next, next as "dark" | "light");
    save("theme", next);
    return;
  }
  try {
    const t = await core.loadTheme(next);
    apply(t.id, t.variant, t.tokens);
    save("theme", t.id);
    save("theme-tokens", t);
  } catch (e) {
    return errorMessage(e);
  }
}
