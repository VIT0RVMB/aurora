import { createEffect, createMemo, For, on, onCleanup, onMount, Show } from "solid-js";
import { modLabel } from "../lib/platform";
import { displayName, statusView } from "../lib/sessions";
import * as sessions from "../state/sessions";

/** The terminal area: side-by-side panes, each with its own session tabs. */
export function Terminals() {
  const ids = createMemo(() => sessions.layout().panes.map((p) => p.id));
  return (
    <section class="terms">
      <For each={ids()}>{(id) => <TerminalPane id={id} />}</For>
    </section>
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
      classList={{ focused: focused() && multi() }}
      onFocusIn={() => {
        sessions.focusPane(p.id);
        sessions.setFocusedTerm(active());
      }}
      onFocusOut={() => sessions.setFocusedTerm(null)}
      onMouseDown={() => sessions.focusPane(p.id)}
    >
      <div class="tabbar" role="tablist">
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
                classList={{ active: id === active(), ended: info() ? !info()!.alive : true }}
                title={info() ? `${info()!.name} · ${info()!.agent} · ${info()!.cwd} · ${view().label}` : id}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  if (e.button === 1) sessions.hideTab(id);
                  else sessions.activateTab(p.id, id);
                }}
              >
                <span class="tab-num">{String(i() + 1).padStart(2, "0")}</span>
                <span class={view().tone}>{view().glyph}</span>
                <span class="tab-name">{info() ? displayName(info()!) : id}</span>
                <button
                  class="tab-close"
                  aria-label="esconder"
                  title="esconder (a sessão continua rodando)"
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
      </div>
      <Show when={sessions.byId(active())?.alive === false}>
        <div class="banner">
          <span class="dim">
            sessão encerrada{sessions.byId(active())?.exitCode != null ? ` (código ${sessions.byId(active())!.exitCode})` : ""}.
          </span>
          <span class="faint">:session rm remove</span>
        </div>
      </Show>
      <div ref={body} class="term-body" classList={{ hidden: !active() }} />
      <Show when={!active()}>
        <div class="editor-empty">
          <div>
            <span class="kbd">:session new claude</span> <span class="dim">nova sessão</span>
          </div>
          <div>
            <span class="kbd">{modLabel}J</span> <span class="dim">esconder terminais</span>
          </div>
        </div>
      </Show>
    </div>
  );
}
