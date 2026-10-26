import { Show } from "solid-js";
import { t } from "../lib/i18n";
import { modLabel } from "../lib/platform";
import * as editor from "../state/editor";
import * as sessions from "../state/sessions";
import * as ui from "../state/ui";
import { Icon } from "./Icon";

/** Shows the open files; with none open, the home screen. */
export function showFiles() {
  if (!editor.tabs.length) return ui.goHome();
  ui.setMode("work");
  ui.setCenterView("auto");
  requestAnimationFrame(() => editor.focusEditor());
}

/** The terminals alone in the center (the board can join them). */
export function showSessions() {
  ui.setMode("sessions");
  if (ui.centerView() !== "kanban") ui.setCenterView("auto");
  ui.setTerminalVisible(true);
  const first = sessions.activeSession() ?? sessions.here().find((s) => s.alive)?.id ?? sessions.here()[0]?.id;
  if (first) void sessions.focusSession(first);
}

/** Which of the activity bar's views is showing. */
export function activeView(): "home" | "files" | "sessions" {
  if (ui.mode() === "sessions") return "sessions";
  const home = ui.centerView() === "home" || (ui.centerView() === "auto" && !editor.tabs.length);
  return home ? "home" : "files";
}

/** Icon column left of the file tree: home, files, sessions. */
export function ActivityBar() {
  const home = () => activeView() === "home";
  const files = () => activeView() === "files";
  const inSessions = () => activeView() === "sessions";
  return (
    <nav class="activity" aria-label={t("activity.label")}>
      <button class="activity-btn" classList={{ active: home() }} title={t("activity.home")} onClick={ui.goHome}>
        <Icon name="home" />
      </button>
      <button
        class="activity-btn"
        classList={{ active: files() }}
        title={t("activity.files", { key: `${modLabel}P` })}
        onClick={showFiles}
      >
        <Icon name="files" />
        <Show when={editor.tabs.length > 0}>
          <span class="activity-badge faint">{editor.tabs.length}</span>
        </Show>
      </button>
      <button class="activity-btn" classList={{ active: inSessions() }} title={t("activity.sessions")} onClick={showSessions}>
        <Icon name="terminal" />
        <Show when={sessions.waiting() > 0}>
          <span class="activity-badge warn">{sessions.waiting()}</span>
        </Show>
      </button>
    </nav>
  );
}

/** Top of the terminals in sessions mode: the board toggle and a new session. */
export function SessionsBar() {
  const board = () => ui.centerView() === "kanban";
  return (
    <div class="sessions-bar">
      <span class="accent">◆</span>
      <b>{t("activity.sessionsTitle")}</b>
      <span class="faint">{sessions.here().length}</span>
      <span class="sessions-bar-gap" />
      <button
        class="sessions-bar-btn"
        classList={{ on: board() }}
        title={t("activity.kanbanHint")}
        onClick={() => ui.setCenterView(board() ? "auto" : "kanban")}
      >
        <Icon name="board" /> {t("activity.kanban")}
      </button>
      <button class="sessions-bar-btn" onClick={() => ui.openPalette("command", ":session new ")}>
        <Icon name="add" /> {t("activity.newSession")}
      </button>
    </div>
  );
}
