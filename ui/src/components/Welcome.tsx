import { For, Show } from "solid-js";
import { modLabel } from "../lib/platform";
import { forgetRecent, openWorkspace, recent } from "../state/workspace";

const LOGO = String.raw`
  __ _ _   _ _ __ ___  _ __ __ _
 / _' | | | | '__/ _ \| '__/ _' |
| (_| | |_| | | | (_) | | | (_| |
 \__,_|\__,_|_|  \___/|_|  \__,_|`;

export function Welcome(p: { onOpen: () => void }) {
  return (
    <div class="welcome">
      <pre class="welcome-logo accent">{LOGO}</pre>
      <div class="welcome-keys">
        <button class="welcome-action" onClick={p.onOpen}>
          <span class="kbd">:open</span> <span class="dim">abrir pasta</span>
        </button>
        <div>
          <span class="kbd">{modLabel}⇧P</span> <span class="dim">comandos</span>
        </div>
      </div>
      <Show when={recent().length}>
        <div class="welcome-recent">
          <div class="faint">recentes</div>
          <For each={recent()}>
            {(path) => (
              <div class="welcome-recent-row">
                <button class="welcome-recent-item" onClick={() => void openWorkspace(path)}>
                  {path}
                </button>
                <button class="faint" title="esquecer" onClick={() => forgetRecent(path)}>
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
