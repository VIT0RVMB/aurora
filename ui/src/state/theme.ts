import { createSignal } from "solid-js";
import { core, errorMessage, type ThemeInfo, type ThemeTokens } from "../lib/ipc";
import { load, save } from "../lib/storage";

/**
 * `dark` (phosphor) and `light` live in tokens.css; `system` is one of them,
 * following the OS; any other id is a scheme file.
 */
export type Theme = string;
export type Variant = "dark" | "light";
const BUILTIN_THEMES = ["system", "dark", "light"] as const;

const isBuiltin = (id: string) => (BUILTIN_THEMES as readonly string[]).includes(id);

const media = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: light)") : undefined;
const osVariant = (): Variant => (media?.matches ? "light" : "dark");

const [theme, setThemeSignal] = createSignal<Theme>("dark");
/** Dark or light as painted; with `system` it changes when the OS does. */
const [variant, setVariant] = createSignal<Variant>("dark");
const [themes, setThemes] = createSignal<ThemeInfo[]>([]);
const [themesDir, setThemesDir] = createSignal("");

export { theme, themes, themesDir, variant };

let applied: string[] = [];

function apply(id: string, v: Variant, tokens: Record<string, string> = {}) {
  const root = document.documentElement;
  for (const k of applied) root.style.removeProperty(k);
  applied = Object.keys(tokens);
  for (const k of applied) root.style.setProperty(k, tokens[k]);
  root.dataset.theme = v;
  setVariant(v);
  setThemeSignal(id);
}

/** A built-in id as painted: `system` resolves to the OS's variant. */
const builtinVariant = (id: string): Variant => (id === "system" ? osVariant() : (id as Variant));

// Phosphor (dark) is the look of the app. A scheme's tokens are cached so it
// paints on the first frame; the core refreshes them right after.
const initial = load<Theme>("theme", "dark");
const cached = load<ThemeTokens | null>("theme-tokens", null);
if (isBuiltin(initial)) apply(initial, builtinVariant(initial));
else if (cached?.id === initial) apply(initial, cached.variant, cached.tokens);
else apply("dark", "dark");
media?.addEventListener("change", () => theme() === "system" && apply("system", osVariant()));

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
  if (next === "toggle") next = variant() === "dark" ? "light" : "dark";
  if (isBuiltin(next)) {
    apply(next, builtinVariant(next));
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
