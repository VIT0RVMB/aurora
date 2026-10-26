import { createSignal } from "solid-js";
import { load, save } from "../lib/storage";

/** `dark` and `light` live in tokens.css; `system` follows the OS. */
export type Theme = "system" | "dark" | "light";
export type Variant = "dark" | "light";
export const THEMES: readonly Theme[] = ["system", "dark", "light"];

const media = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: light)") : undefined;
const osVariant = (): Variant => (media?.matches ? "light" : "dark");

const saved = load<string>("theme", "system");
const [theme, setThemeSignal] = createSignal<Theme>((THEMES as readonly string[]).includes(saved) ? (saved as Theme) : "system");
const [variant, setVariant] = createSignal<Variant>("dark");

export { theme, variant };

function apply() {
  const v = theme() === "system" ? osVariant() : (theme() as Variant);
  document.documentElement.dataset.theme = v;
  setVariant(v);
}

apply();
media?.addEventListener("change", () => theme() === "system" && apply());

/** Switches theme; `toggle` flips the variant on screen. */
export function setTheme(next: Theme | "toggle"): void {
  if (next === "toggle") next = variant() === "dark" ? "light" : "dark";
  setThemeSignal(next);
  save("theme", next);
  apply();
}
