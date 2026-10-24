import { For, Show } from "solid-js";
import { modLabel } from "../lib/platform";
import { forgetRecent, openWorkspace, recent } from "../state/workspace";
import { t } from "../lib/i18n";

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
          <span class="kbd">:open</span> <span class="dim">{t("welcome.open")}</span>
        </button>
        <div>
          <span class="kbd">{modLabel}⇧P</span> <span class="dim">{t("empty.commands")}</span>
        </div>
      </div>
      <Show when={recent().length}>
        <div class="welcome-recent">
          <div class="faint">{t("welcome.recent")}</div>
          <For each={recent()}>
            {(path) => (
              <div class="welcome-recent-row">
                <button class="welcome-recent-item" onClick={() => void openWorkspace(path)}>
                  {path}
                </button>
                <button class="faint" title={t("welcome.forget")} onClick={() => forgetRecent(path)}>
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
