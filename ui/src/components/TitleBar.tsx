import { Show } from "solid-js";
import { modLabel } from "../lib/platform";
import * as sessions from "../state/sessions";
import { rightVisible, toggleRight, toggleTree, treeVisible } from "../state/ui";
import { workspace } from "../state/workspace";
import { t } from "../lib/i18n";

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
      <span class="titlebar-side" data-tauri-drag-region>
        <Show when={workspace()}>
          <button
            class="titlebar-toggle"
            classList={{ on: treeVisible() }}
            title={t(treeVisible() ? "title.hideFiles" : "title.showFiles", { key: `${modLabel}B` })}
            onClick={() => toggleTree()}
          >
            ◧
          </button>
        </Show>
      </span>
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
              <span class="accent">▪</span> {live()} {live() === 1 ? t("title.session") : t("title.sessions")}
            </Show>
          }
        >
          <span class="warn">◆ {t("title.waiting", { n: sessions.waiting() })}</span>
        </Show>
        <Show when={workspace()}>
          <button
            class="titlebar-toggle"
            classList={{ on: rightVisible() }}
            title={t(rightVisible() ? "title.hidePanel" : "title.showPanel", {
              key: `${modLabel}${modLabel === "⌘" ? "⇧" : "Shift+"}B`,
            })}
            onClick={() => toggleRight()}
          >
            ◨
          </button>
        </Show>
      </span>
    </header>
  );
}
