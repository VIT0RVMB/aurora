import { createSignal, For, Show } from "solid-js";
import { isMac, isMod, modLabel } from "../lib/platform";
import { displayName, statusView } from "../lib/sessions";
import { ago, shortPath } from "../lib/text";
import { archiveMany, endMany, removeMany, sessionMenu, sessionsMenu } from "../state/menus";
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

  // Several sessions picked for archive / end / remove at once: Mod-click
  // toggles one, Shift-click (or Shift+arrows) takes a range, Esc clears.
  const [marked, setMarked] = createSignal<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = createSignal(0);
  const picked = () => list().filter((s) => marked().has(s.id));
  const clear = () => setMarked(new Set<string>());
  const toggle = (id: string) =>
    setMarked((m) => {
      const next = new Set(m);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const range = (a: number, b: number) =>
    setMarked(new Set(list().slice(Math.min(a, b), Math.max(a, b) + 1).map((s) => s.id)));
  // Archived and removed sessions drop out of `picked` by themselves; ended ones
  // stay picked (to remove next), and a cancelled dialog keeps the selection.
  const bulk = (p: Promise<unknown>) => void p;
  const view = (archived: boolean) => (setShowArchived(archived), setCursor(0), clear());

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
    const down = e.key === "ArrowDown" || e.key === "j";
    const up = e.key === "ArrowUp" || e.key === "k";
    if (e.shiftKey && (down || up)) {
      if (!marked().size) setAnchor(cursor());
      const c = Math.max(0, Math.min(n - 1, cursor() + (down ? 1 : -1)));
      setCursor(c);
      range(anchor(), c);
    } else if (down) setCursor((c) => (c + 1) % n);
    else if (up) setCursor((c) => (c - 1 + n) % n);
    else if (e.key === " ") {
      setAnchor(cursor());
      toggle(list()[cursor()].id);
    } else if (isMod(e) && e.key.toLowerCase() === "a") setMarked(new Set(list().map((s) => s.id)));
    else if (e.key === "Escape" && marked().size) clear();
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
            onClick={() => view(false)}
          >
            {t("sessions.active", { n: sessions.here().length })}
          </button>
          <button
            class="sessions-head-btn"
            classList={{ on: viewingArchived() }}
            title={t("sessions.unarchiveHint")}
            onClick={() => view(true)}
          >
            {t("sessions.archivedTitle", { n: sessions.archived().length })}
          </button>
        </div>
      </Show>
      <Show when={picked().length > 0}>
        <div class="sessions-bulk">
          <span>{t("sessions.selected", { n: picked().length })}</span>
          <span class="sessions-bulk-gap" />
          <button
            class="sessions-head-btn"
            onClick={() => bulk(archiveMany(picked(), !viewingArchived()))}
          >
            {t(viewingArchived() ? "menu.unarchive" : "menu.archive")}
          </button>
          <Show when={picked().some((s) => s.alive)}>
            <button class="sessions-head-btn danger" onClick={() => bulk(endMany(picked()))}>
              {t("menu.end")}
            </button>
          </Show>
          <button class="sessions-head-btn danger" onClick={() => bulk(removeMany(picked()))}>
            {t("bulk.remove")}
          </button>
          <button class="sessions-head-btn" title={t("sessions.clearSel")} onClick={clear}>
            ✕
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
                  marked: marked().has(s.id),
                  active: s.id === sessions.activeSession(),
                  ended: !s.alive,
                  colored: !!s.color,
                }}
                style={s.color ? { "--sc": `var(--sc-${s.color})` } : undefined}
                onContextMenu={(e) =>
                  marked().has(s.id) && picked().length > 1 ? sessionsMenu(e, picked()) : sessionMenu(e, s)
                }
                // Shift-click would also select the page's text.
                onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                onClick={(e) => {
                  if (isMac ? e.metaKey : e.ctrlKey) {
                    // Like Finder: the row clicked before joins the selection.
                    const first = list()[cursor()];
                    if (!marked().size && first && first.id !== s.id) toggle(first.id);
                    setCursor(i());
                    setAnchor(i());
                    return toggle(s.id);
                  }
                  setCursor(i());
                  if (e.shiftKey) return range(anchor(), i());
                  clear();
                  setAnchor(i());
                  open(i());
                }}
                title={[displayName(s), s.name, view().label, s.agent, s.branch && `⎇ ${s.branch}`, s.worktree ?? s.cwd]
                  .filter(Boolean)
                  .join(" · ")
                  .concat("\n", t("sessions.multiHint", { mod: isMac ? "⌘-" : "Ctrl-" }))}
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
