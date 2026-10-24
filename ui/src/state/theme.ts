import { createSignal } from "solid-js";
import { load, save } from "../lib/storage";

export type Theme = "dark" | "light";

// Phosphor (dark) is the look of the app; light is opt-in with `:theme light`.
const initial: Theme = load<Theme>("theme", "dark");

const [theme, setThemeSignal] = createSignal<Theme>(initial);
document.documentElement.dataset.theme = initial;

export { theme };

export function setTheme(next: Theme | "toggle") {
  const value: Theme = next === "toggle" ? (theme() === "dark" ? "light" : "dark") : next;
  setThemeSignal(value);
  document.documentElement.dataset.theme = value;
  save("theme", value);
}
