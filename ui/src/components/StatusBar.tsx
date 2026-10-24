import { For, Show } from "solid-js";
import { modLabel } from "../lib/platform";
import { displayName } from "../lib/sessions";
import { activeTab, cursor, vimEnabled, vimMode } from "../state/editor";
import * as sessions from "../state/sessions";
import * as ui from "../state/ui";
import { message } from "../state/ui";
import { workspace } from "../state/workspace";

/** Vim-style mode badge: what the keys do right now. */
function mode(): { text: string; tone: string } {
  if (ui.area() === "terminal") return { text: "TERMINAL", tone: "mode-term" };
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
      <span class={`status-mode ${mode().tone}`}>{mode().text}</span>
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
            <span class="faint">|</span>
            <span>{tab().plain ? "plain" : (tab().language ?? "text")}</span>
            <span class="faint">|</span>
            <span>{tab().eol.toUpperCase()}</span>
            <span class="faint">|</span>
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
        { key: `${modLabel}J`, label: "esconder" },
        { key: `${modLabel}\\`, label: "dividir" },
        { key: "Ctrl+Tab", label: "próxima" },
        { key: `${modLabel}⇧A`, label: "sessões" },
        { key: `${modLabel}⇧P`, label: "comandos" },
      ];
    case "editor":
      return [
        { key: "Space", label: "leader" },
        { key: `${modLabel}P`, label: "find" },
        { key: ":w", label: "salvar" },
        { key: ":q", label: "fechar" },
        { key: ":vim off", label: "sem vim" },
      ];
    default:
      return [
        { key: "Space", label: "leader" },
        { key: `${modLabel}P`, label: "find" },
        { key: ":session new", label: "agente" },
        { key: `${modLabel}J`, label: "terminais" },
        { key: ":qa", label: "sair" },
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
