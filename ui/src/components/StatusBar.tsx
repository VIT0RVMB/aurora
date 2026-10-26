import { For, Show } from "solid-js";
import { modLabel } from "../lib/platform";
import { displayName } from "../lib/sessions";
import { activeTab, cursor, vimEnabled, vimMode } from "../state/editor";
import * as sessions from "../state/sessions";
import * as ui from "../state/ui";
import { message } from "../state/ui";
import { workspace } from "../state/workspace";
import { t } from "../lib/i18n";

/** Vim-style mode badge: what the keys do right now. */
function mode(): { text: string; tone: string } {
  if (ui.area() === "terminal") return { text: "TERMINAL", tone: "mode-term" };
  if (ui.area() === "board") return { text: "BOARD", tone: "mode-visual" };
  if (ui.area() === "editor") {
    if (!vimEnabled()) return { text: "EDIT", tone: "mode-insert" };
    const m = vimMode();
    if (m === "insert") return { text: "INSERT", tone: "mode-insert" };
    if (m === "replace") return { text: "REPLACE", tone: "mode-insert" };
    if (m.startsWith("v")) return { text: m === "visual" ? "VISUAL" : m.toUpperCase(), tone: "mode-visual" };
  }
  return { text: "NORMAL", tone: "" };
}

export function StatusBar() {
  const term = () => (ui.area() === "terminal" ? sessions.byId(sessions.activeSession()) : undefined);
  return (
    <footer class="statusbar">
      <Show when={vimEnabled()}>
        <span class={`status-mode ${mode().tone}`}>{mode().text}</span>
      </Show>
      <Show
        when={term()}
        fallback={
          <Show when={activeTab()} fallback={<span class="status-seg">{workspace()?.name}</span>}>
            {(tab) => (
              <span class="status-seg status-path">
                {tab().name}
                <Show when={tab().dirty}>
                  <span class="warn"> [+]</span>
                </Show>
              </span>
            )}
          </Show>
        }
      >
        {(s) => (
          <span class="status-seg status-path">
            {displayName(s())} <span class="faint">{s().agent}{s().branch ? ` ⎇ ${s().branch}` : ""}</span>
          </span>
        )}
      </Show>
      <Show when={sessions.connected() === false}>
        <span class="status-seg danger">sessiond off</span>
      </Show>
      <span class="status-msg" classList={{ [message()?.tone ?? "info"]: true }}>
        {message()?.text}
      </span>
      <Show when={!term() && activeTab()}>
        {(tab) => (
          <span class="status-right">
            <span>UTF-8</span>
            <span>{tab().plain ? "plain" : (tab().language ?? "text")}</span>
            <span>{tab().eol.toUpperCase()}</span>
            <span>
              {cursor().line}:{cursor().col}
            </span>
          </span>
        )}
      </Show>
    </footer>
  );
}

interface Hint {
  key: string;
  label: string;
}

function hints(): Hint[] {
  switch (ui.area()) {
    case "terminal":
      return [
        { key: `${modLabel}J`, label: t("hint.hide") },
        { key: `${modLabel}\\`, label: t("hint.split") },
        { key: `${modLabel}⇧\\`, label: t("hint.stack") },
        { key: "Ctrl+Tab", label: t("hint.next") },
        { key: `${modLabel}⇧A`, label: t("hint.sessions") },
        { key: `${modLabel}⇧P`, label: t("hint.commands") },
      ];
    case "board":
      return [
        { key: "h/l", label: t("hint.column") },
        { key: "j/k", label: t("hint.card") },
        { key: "H/L", label: t("hint.move") },
        { key: "⏎", label: t("hint.open") },
        { key: "esc", label: t("hint.back") },
      ];
    case "editor":
      return [
        { key: "Space", label: t("hint.leader") },
        { key: `${modLabel}P`, label: t("hint.find") },
        { key: ":w", label: t("hint.save") },
        { key: ":q", label: t("hint.close") },
        { key: ":vim off", label: t("hint.noVim") },
      ];
    default:
      return [
        { key: "Space", label: t("hint.leader") },
        { key: `${modLabel}P`, label: t("hint.find") },
        { key: ":session new", label: t("hint.agent") },
        { key: `${modLabel}J`, label: t("hint.terminals") },
        { key: ":qa", label: t("hint.quit") },
      ];
  }
}

/** One line of what you can press now, like a TUI's footer. */
export function HintBar() {
  return (
    <div class="hintbar">
      <For each={hints()}>
        {(h) => (
          <span class="hint">
            <b>{h.key}</b> <span class="dim">{h.label}</span>
          </span>
        )}
      </For>
    </div>
  );
}
