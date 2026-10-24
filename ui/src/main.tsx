import { render } from "solid-js/web";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";
import { syncTheme } from "./state/theme";

async function boot() {
  // In a plain browser (no Tauri), dev builds fall back to a fake core.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    (await import("./dev/mock")).installMock();
  }
  void syncTheme();
  render(() => <App />, document.getElementById("root")!);
  if (import.meta.env.DEV && "__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    const mode = await invoke<string | null>("dev_smoke").catch(() => null);
    if (mode) void (await import("./dev/smoke")).runSmoke(mode);
  }
}

void boot();
