import { createSignal, For, Show } from "solid-js";
import { modLabel } from "../lib/platform";
import { displayName, statusView } from "../lib/sessions";
import * as sessions from "../state/sessions";
import { t } from "../lib/i18n";

function shortPath(p: string) {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

/** Sessions of the open workspace: status first, then who and where. */
export function SessionsPanel() {
  const [cursor, setCursor] = createSignal(0);
  const list = sessions.here;
  const others = () => sessions.all.length - list().length;

  const open = (i: number) => {
    const s = list()[i];
    if (s) void sessions.focusSession(s.id);
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
      <div class="sessions-list" tabindex="0" onKeyDown={onKey}>
        <For each={list()}>
          {(s, i) => {
            const view = () => statusView(s);
            return (
              <button
                class="session-row"
                classList={{
                  selected: i() === cursor(),
                  active: s.id === sessions.activeSession(),
                  ended: !s.alive,
                }}
                onClick={() => {
                  setCursor(i());
                  open(i());
                }}
                title={s.cwd}
              >
                <div class="session-line">
                  <span class={view().tone}>{view().glyph}</span>
                  <span class="session-name">{displayName(s)}</span>
                  <span class={`session-status ${view().tone}`}>{view().label}</span>
                </div>
                <div class="session-line dim">
                  <span class="faint"> </span>
                  <span class="session-meta">
                    <Show when={displayName(s) !== s.name}>
                      {s.name}
                      <span class="faint"> · </span>
                    </Show>
                    {s.agent}
                    <Show when={s.branch}>
                      <span class="faint"> ⎇ </span>
                      {s.branch}
                    </Show>
                    <Show when={s.worktree}>
                      <span class="faint"> · {shortPath(s.worktree!)}</span>
                    </Show>
                  </span>
                </div>
              </button>
            );
          }}
        </For>
        <Show when={list().length === 0}>
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
