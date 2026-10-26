import { createEffect, createResource, For, on, onCleanup, Show, type JSX } from "solid-js";
import { locale, t } from "../lib/i18n";
import { core, type SessionInfo, type WorktreeStatus } from "../lib/ipc";
import { modLabel } from "../lib/platform";
import { displayName, sameFolder, statusView } from "../lib/sessions";
import { ago, shortPath } from "../lib/text";
import { baseName, parentPath } from "../lib/tree";
import { openFile, recentFiles } from "../state/editor";
import { sessionMenu } from "../state/menus";
import { fsTick } from "../state/changes";
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
function Row(p: {
  glyph: JSX.Element;
  name: string;
  meta?: JSX.Element;
  age?: string;
  title?: string;
  color?: string | null;
  /** The meta is what matters (a count): it never gets cut. */
  keepMeta?: boolean;
  onOpen: () => void;
  onMenu?: (e: MouseEvent) => void;
}) {
  return (
    <button
      class="home-row"
      classList={{ colored: !!p.color }}
      style={p.color ? { "--sc": `var(--sc-${p.color})` } : undefined}
      title={p.title}
      onClick={p.onOpen}
      onContextMenu={p.onMenu}
    >
      <span class="home-glyph">{p.glyph}</span>
      <span class="home-name">{p.name}</span>
      <span class="home-meta" classList={{ keep: p.keepMeta }}>
        {p.meta}
      </span>
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
      color={p.s.color}
      onOpen={() => void sessions.focusSession(p.s.id)}
      onMenu={(e) => sessionMenu(e, p.s)}
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
  // Every worktree of the repository, sessions' or yours, with what is uncommitted in it.
  const [trees, { refetch }] = createResource(
    () => workspace()?.root,
    () => core.worktrees().catch(() => null),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      // Agents writing (status, activity) and files changing by hand both change counts.
      () => [sessions.here().map((s) => `${s.id}:${s.status}:${s.updatedMs}`).join(), fsTick()],
      () => {
        clearTimeout(timer);
        timer = setTimeout(() => void refetch(), 500);
      },
      { defer: true },
    ),
  );
  // Worktrees live outside the watched folder: coming back to the window (after
  // editing elsewhere) is the other moment they may have changed.
  const onWindowFocus = () => void refetch();
  window.addEventListener("focus", onWindowFocus);
  onCleanup(() => {
    clearTimeout(timer);
    window.removeEventListener("focus", onWindowFocus);
  });
  /** Sessions working in a worktree: its owners, or for the main checkout those without one. */
  const users = (w: WorktreeStatus) =>
    sessions.here().filter((s) => (w.main ? !s.worktree && sameFolder(s.cwd, w.path) : !!s.worktree && sameFolder(s.worktree, w.path)));

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
            <Box title={t("home.worktrees")} count={trees()?.length ?? 0}>
              <For
                each={trees() ?? []}
                fallback={<div class="home-empty">{trees() === null ? t("home.notRepo") : t("home.noWorktrees")}</div>}
              >
                {(w) => {
                  const who = () => users(w);
                  const tone = () => (w.changed == null ? "danger" : w.changed > 0 ? "warn" : "faint");
                  return (
                    <Row
                      glyph={<span class={tone()}>⎇</span>}
                      name={w.main ? `${w.branch || "HEAD"} · ${t("home.mainCheckout")}` : w.branch || shortPath(w.path)}
                      title={[w.path, ...who().map(displayName)].join("\n")}
                      keepMeta
                      meta={
                        <span class={tone()}>
                          {w.changed == null
                            ? t("home.missing")
                            : w.changed > 0
                              ? t("home.changedN", { n: w.changed })
                              : t("home.clean")}
                        </span>
                      }
                      age={
                        who().length > 1
                          ? t("home.sessionsN", { n: who().length })
                          : who().length
                            ? displayName(who()[0])
                            : w.main
                              ? undefined
                              : t("home.manual")
                      }
                      color={who()[0]?.color}
                      onOpen={() => {
                        const s = who()[0];
                        if (s) void sessions.focusSession(s.id);
                      }}
                      onMenu={who()[0] ? (e) => sessionMenu(e, who()[0]) : undefined}
                    />
                  );
                }}
              </For>
            </Box>
          </div>
        </div>
      </div>
    </div>
  );
}
