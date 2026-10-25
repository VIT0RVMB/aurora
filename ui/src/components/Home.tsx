import { createEffect, createResource, For, Show, type JSX } from "solid-js";
import { locale, t } from "../lib/i18n";
import { core, type SessionInfo } from "../lib/ipc";
import { modLabel } from "../lib/platform";
import { displayName, statusView } from "../lib/sessions";
import { ago, shortPath } from "../lib/text";
import { baseName, parentPath } from "../lib/tree";
import { openFile, recentFiles } from "../state/editor";
import * as sessions from "../state/sessions";
import { now, openPalette, setPrefsOpen, setSearchFocus, showRight } from "../state/ui";
import { workspace } from "../state/workspace";

function Box(p: { title: JSX.Element; count?: number; children: JSX.Element }) {
  return (
    <div class="box home-box">
      <div class="box-title">
        {p.title}
        <Show when={p.count != null}>
          <span class="count">{p.count}</span>
        </Show>
      </div>
      <div class="home-rows">{p.children}</div>
    </div>
  );
}

/** One list line: glyph, name, then meta and age pushed to the right. */
function Row(p: { glyph: JSX.Element; name: string; meta?: JSX.Element; age?: string; title?: string; onOpen: () => void }) {
  return (
    <button class="home-row" title={p.title} onClick={p.onOpen}>
      <span class="home-glyph">{p.glyph}</span>
      <span class="home-name">{p.name}</span>
      <span class="home-meta">{p.meta}</span>
      <span class="home-age">{p.age}</span>
    </button>
  );
}

function SessionRow(p: { s: SessionInfo }) {
  const view = () => statusView(p.s);
  return (
    <Row
      glyph={<span class={view().tone}>{view().glyph}</span>}
      name={displayName(p.s)}
      title={p.s.cwd}
      meta={
        <>
          {p.s.agent}
          <Show when={p.s.branch}>
            <span class="faint"> ⎇ </span>
            {p.s.branch}
          </Show>
        </>
      }
      age={ago(p.s.updatedMs, now())}
      onOpen={() => void sessions.focusSession(p.s.id)}
    />
  );
}

/**
 * What the editor shows with no file open: who needs you, what is running,
 * where you were, and which worktrees have work in them.
 */
export function Home() {
  const live = () => sessions.here().filter((s) => s.alive);
  const waiting = () => live().filter((s) => s.status === "waiting");
  const running = () => live().filter((s) => s.status !== "waiting");
  const withWorktree = () => sessions.here().filter((s) => s.worktree);

  // Dirty flags for worktrees, refreshed whenever the set of sessions changes.
  const [dirty, { refetch }] = createResource(
    () => withWorktree().map((s) => s.id).join(","),
    async (ids) => {
      const out = new Map<string, boolean>();
      for (const id of ids.split(",").filter(Boolean)) {
        out.set(id, await core.sessionWorktreeDirty(id).catch(() => false));
      }
      return out;
    },
  );
  createEffect(() => {
    // Statuses changing usually means files changed too.
    sessions.waiting();
    void refetch();
  });

  const today = () =>
    new Intl.DateTimeFormat(locale(), { weekday: "long", month: "long", day: "numeric" }).format(new Date(now()));

  const keys: [string, () => string, () => void][] = [
    [`${modLabel}P`, () => t("home.kOpen"), () => openPalette("files")],
    [
      `${modLabel}⇧F`,
      () => t("home.kSearch"),
      () => {
        showRight("search");
        setSearchFocus((n) => n + 1);
      },
    ],
    ["Space n", () => t("home.kNew"), () => openPalette("command", ":session new ")],
    [`${modLabel}J`, () => t("home.kTerms"), () => sessions.toggleArea()],
    [`${modLabel},`, () => t("home.kPrefs"), () => setPrefsOpen(true)],
  ];

  return (
    <div class="home">
      <div class="box home-frame">
        <div class="box-title">home</div>
        <div class="home-head">
          <span>
            <span class="accent">✦ {workspace()?.name}</span>
            <span class="dim">  {today()}</span>
          </span>
          <span class="dim">{t("home.summary", { n: live().length, w: waiting().length })}</span>
        </div>
        <div class="home-keys">
          <For each={keys}>
            {([key, label, run]) => (
              <button class="home-key" onClick={run}>
                <b>{key}</b> {label()}
              </button>
            )}
          </For>
        </div>
        <div class="home-grid">
          <div class="home-col">
            <Box title={<span class="warn">◆ {t("home.waiting")}</span>} count={waiting().length}>
              <For each={waiting()} fallback={<div class="home-empty">{t("home.nothingWaiting")}</div>}>
                {(s) => <SessionRow s={s} />}
              </For>
            </Box>
            <Box title={t("home.running")} count={running().length}>
              <For each={running()} fallback={<div class="home-empty">{t("home.noneRunning")}</div>}>
                {(s) => <SessionRow s={s} />}
              </For>
            </Box>
          </div>
          <div class="home-col">
            <Box title={t("home.recent")}>
              <For
                each={recentFiles().slice(0, 8)}
                fallback={<div class="home-empty">{t("home.noRecent", { key: `${modLabel}P` })}</div>}
              >
                {(f) => (
                  <Row
                    glyph={<span class="faint">·</span>}
                    name={baseName(f.path)}
                    title={f.path}
                    meta={<span class="faint">{parentPath(f.path)}</span>}
                    age={ago(f.at, now())}
                    onOpen={() => void openFile(f.path)}
                  />
                )}
              </For>
            </Box>
            <Box title={t("home.worktrees")} count={withWorktree().length}>
              <For each={withWorktree()} fallback={<div class="home-empty">{t("home.noWorktrees")}</div>}>
                {(s) => (
                  <Row
                    glyph={<span class={dirty()?.get(s.id) ? "warn" : "faint"}>⎇</span>}
                    name={s.branch ?? shortPath(s.worktree!)}
                    title={s.worktree!}
                    meta={
                      <span class={dirty()?.get(s.id) ? "warn" : "faint"}>
                        {dirty()?.get(s.id) ? t("home.dirty") : t("home.clean")}
                      </span>
                    }
                    age={displayName(s) !== s.branch ? displayName(s) : undefined}
                    onOpen={() => void sessions.focusSession(s.id)}
                  />
                )}
              </For>
            </Box>
          </div>
        </div>
      </div>
    </div>
  );
}
