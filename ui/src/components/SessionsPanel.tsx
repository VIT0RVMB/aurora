import { createSignal, For, Show } from "solid-js";
import { modLabel } from "../lib/platform";
import { displayName, statusView } from "../lib/sessions";
import { ago, shortPath } from "../lib/text";
import { sessionMenu } from "../state/menus";
import * as sessions from "../state/sessions";
import { now } from "../state/ui";
import { t } from "../lib/i18n";

/** Sessions of the open workspace: status first, then who and where. */
export function SessionsPanel() {
  const [cursor, setCursor] = createSignal(0);
  // Archived sessions are not listed; the header switches to them.
  const [showArchived, setShowArchived] = createSignal(false);
  const viewingArchived = () => showArchived() && sessions.archived().length > 0;
  const list = () => (viewingArchived() ? sessions.archived() : sessions.here());
  const others = () => sessions.all.length - sessions.here().length - sessions.archived().length;

  const open = (i: number) => {
    const s = list()[i];
    if (!s) return;
    if (!s.archived) return void sessions.focusSession(s.id);
    // Opening an archived one brings it back.
    void sessions.setArchived(s, false).then((err) => (err ? undefined : sessions.focusSession(s.id)));
  };

  const onKey = (e: KeyboardEvent) => {
    const n = list().length;
    if (!n) return;
    if (e.key === "ArrowDown" || e.key === "j") setCursor((c) => (c + 1) % n);
    else if (e.key === "ArrowUp" || e.key === "k") setCursor((c) => (c - 1 + n) % n);
    else if (e.key === "Enter") open(cursor());
    else return;
    e.preventDefault();
  };

  return (
    <section class="sessions">
      <Show when={sessions.archived().length > 0}>
        <div class="sessions-head">
          <button
            class="sessions-head-btn"
            classList={{ on: !viewingArchived() }}
            onClick={() => (setShowArchived(false), setCursor(0))}
          >
            {t("sessions.active", { n: sessions.here().length })}
          </button>
          <button
            class="sessions-head-btn"
            classList={{ on: viewingArchived() }}
            title={t("sessions.unarchiveHint")}
            onClick={() => (setShowArchived(true), setCursor(0))}
          >
            {t("sessions.archivedTitle", { n: sessions.archived().length })}
          </button>
        </div>
      </Show>
      <div class="sessions-list" tabindex="0" onKeyDown={onKey}>
        <For each={list()}>
          {(s, i) => {
            const view = () => statusView(s);
            return (
              <button
                class="session-row"
                classList={{
                  archived: !!s.archived,
                  selected: i() === cursor(),
                  active: s.id === sessions.activeSession(),
                  ended: !s.alive,
                  colored: !!s.color,
                }}
                style={s.color ? { "--sc": `var(--sc-${s.color})` } : undefined}
                onContextMenu={(e) => sessionMenu(e, s)}
                onClick={() => {
                  setCursor(i());
                  open(i());
                }}
                title={[displayName(s), s.name, view().label, s.agent, s.branch && `⎇ ${s.branch}`, s.worktree ?? s.cwd]
                  .filter(Boolean)
                  .join(" · ")}
              >
                <span class={view().tone}>{view().glyph}</span>
                <span class="session-name">{displayName(s)}</span>
                <Show
                  when={s.alive && s.status === "waiting"}
                  fallback={
                    <span class="session-meta faint">
                      {s.agent}
                      <Show when={s.branch}> ⎇ {s.branch}</Show>
                      <Show when={s.worktree}> · {shortPath(s.worktree!)}</Show>
                    </span>
                  }
                >
                  <span class="session-meta warn">{view().label}</span>
                </Show>
                <span class="session-age">{ago(s.updatedMs, now())}</span>
              </button>
            );
          }}
        </For>
        <Show when={list().length === 0 && !viewingArchived()}>
          <div class="sessions-empty">
            <Show when={sessions.connected() !== false} fallback={<span class="danger">{t("sessions.unavailable")}</span>}>
              <span class="dim">{t("sessions.none")}</span>
            </Show>
            <span class="kbd">:session new claude</span>
            <span class="kbd">:session new codex -w fix-bug</span>
            <span class="faint">
              {modLabel}J {t("sessions.toggleTerms")}
            </span>
          </div>
        </Show>
      </div>
      <Show when={others() > 0}>
        <div class="sessions-footer faint">{t("sessions.others", { n: others() })}</div>
      </Show>
    </section>
  );
}
