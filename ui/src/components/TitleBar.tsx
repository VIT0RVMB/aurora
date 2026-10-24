import { Show } from "solid-js";
import * as sessions from "../state/sessions";
import { workspace } from "../state/workspace";

/** Inside the native window, macOS draws its traffic lights over the left edge. */
const overlayLights = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && /Mac/.test(navigator.platform);

function tilde(p: string) {
  return p.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, "~");
}

/** The window's own title bar: where you are, and whether a session needs you. */
export function TitleBar() {
  const live = () => sessions.here().filter((s) => s.alive).length;
  return (
    <header class="titlebar" classList={{ lights: overlayLights }} data-tauri-drag-region>
      <span class="titlebar-side" data-tauri-drag-region />
      <span class="titlebar-title" data-tauri-drag-region>
        <b data-tauri-drag-region>aurora</b>
        <Show when={workspace()}>
          <span class="faint" data-tauri-drag-region>
            {" · "}
            {tilde(workspace()!.root)}
          </span>
        </Show>
      </span>
      <span class="titlebar-side right" data-tauri-drag-region>
        <Show
          when={sessions.waiting() > 0}
          fallback={
            <Show when={live() > 0}>
              <span class="accent">▪</span> {live()} {live() === 1 ? "SESSÃO" : "SESSÕES"}
            </Show>
          }
        >
          <span class="warn">◆ {sessions.waiting()} AGUARDANDO</span>
        </Show>
      </span>
    </header>
  );
}
