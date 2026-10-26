import { createEffect, createMemo, For, on, onCleanup, onMount, Show } from "solid-js";
import { modLabel } from "../lib/platform";
import { displayName, statusView } from "../lib/sessions";
import * as sessions from "../state/sessions";
import { t } from "../lib/i18n";
import { startTabDrag } from "../state/drag";
import { sessionMenu } from "../state/menus";
import { SplitArea } from "./SplitArea";
import { TabStrip } from "./TabStrip";
import { shortPath } from "../lib/text";

/** The terminal area: panes side by side or stacked, each with its own session tabs. */
export function Terminals() {
  return (
    <SplitArea class="terms" layout={sessions.layout()} onResize={sessions.resizePanes}>
      {(id) => <TerminalPane id={id} />}
    </SplitArea>
  );
}

function TerminalPane(p: { id: number }) {
  let body!: HTMLDivElement;
  const pane = createMemo(() => sessions.layout().panes.find((x) => x.id === p.id));
  const active = () => pane()?.active ?? null;
  const focused = () => sessions.layout().focused === p.id;
  const multi = () => sessions.layout().panes.length > 1;

  // Mount the active session's terminal; each switch moves its DOM node here.
  createEffect(
    on(active, async (id) => {
      if (!id) return body.replaceChildren();
      const t = await sessions.terminal(id);
      if (active() !== id) return;
      t.mount(body);
      sessions.rememberSize(t.size().cols, t.size().rows);
    }),
  );

  onMount(() => {
    const ro = new ResizeObserver(() => {
      const id = active();
      if (!id) return;
      void sessions.terminal(id).then((t) => {
        t.fit();
        sessions.rememberSize(t.size().cols, t.size().rows);
      });
    });
    ro.observe(body);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div
      class="term-pane"
      classList={{ focused: focused() && multi(), dimmed: multi() && !focused() }}
      onFocusIn={() => {
        sessions.focusPane(p.id);
        sessions.setFocusedTerm(active());
      }}
      onFocusOut={() => sessions.setFocusedTerm(null)}
      onMouseDown={() => sessions.focusPane(p.id)}
      data-drop-pane={p.id}
      data-kind="session"
    >
      <TabStrip pane={p.id} kind="session">
        <For each={pane()?.tabs ?? []}>
          {(id, i) => {
            const info = () => sessions.byId(id);
            const view = () => {
              const s = info();
              return s ? statusView(s) : { glyph: "?", label: "", tone: "faint" as const };
            };
            return (
              <div
                class="tab"
                role="tab"
                aria-selected={id === active()}
                classList={{ active: id === active(), ended: info() ? !info()!.alive : true, colored: !!info()?.color }}
                style={info()?.color ? { "--sc": `var(--sc-${info()!.color})` } : undefined}
                onContextMenu={(e) => {
                  const s = info();
                  if (s) sessionMenu(e, s);
                }}
                title={info() ? `${info()!.name} · ${info()!.agent} · ${info()!.cwd} · ${view().label}` : id}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  if (e.button === 1) sessions.hideTab(id);
                  else sessions.activateTab(p.id, id);
                }}
                onPointerDown={(e) =>
                  startTabDrag(e, {
                    kind: "session",
                    label: info() ? displayName(info()!) : id,
                    canDrop: (t) => sessions.canDropTab(id, t),
                    onDrop: (t) => sessions.dropTab(id, t),
                  })
                }
              >
                <span class="tab-num">{String(i() + 1).padStart(2, "0")}</span>
                <span class={view().tone}>{view().glyph}</span>
                <span class="tab-name">{info() ? displayName(info()!) : id}</span>
                <button
                  class="tab-close"
                  aria-label={t("term.hide")}
                  title={t("term.hideTitle")}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    sessions.hideTab(id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          }}
        </For>
      </TabStrip>
      <Show when={sessions.byId(active())?.alive === false}>
        <div class="banner">
          <span class="dim">
            {sessions.byId(active())?.exitCode != null
              ? t("term.endedCode", { code: sessions.byId(active())!.exitCode! })
              : t("term.ended")}
          </span>
          <span class="faint">{t("term.rmHint")}</span>
        </div>
      </Show>
      <div class="box" classList={{ hidden: !active() }}>
        <div class="box-title">
          <Show when={sessions.byId(active())}>
            {(s) => (
              <>
                {s().agent}
                <span class="faint"> · </span>
                {shortPath(s().cwd)}
                <Show when={s().branch}>
                  <span class="faint"> ⎇ </span>
                  {s().branch}
                </Show>
              </>
            )}
          </Show>
        </div>
        <div ref={body} class="term-body" />
      </div>
      <Show when={!active()}>
        <div class="editor-empty">
          <div>
            <span class="kbd">:session new claude</span> <span class="dim">{t("term.new")}</span>
          </div>
          <div>
            <span class="kbd">{modLabel}J</span> <span class="dim">{t("term.hideAll")}</span>
          </div>
        </div>
      </Show>
    </div>
  );
}
