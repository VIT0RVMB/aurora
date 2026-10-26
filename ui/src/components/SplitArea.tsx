import { createMemo, For, Index, Show, type JSX } from "solid-js";
import { arrange, splitAt, treeOf, type Divider, type Layout } from "../lib/panes";
import { drag } from "../state/drag";

/** Narrowest a pane may be dragged to, in pixels. */
const MIN_PX = 80;

/**
 * Lays panes out from the layout's split tree. Each pane is placed by
 * position, never re-parented, so editors and terminals inside are not
 * remounted when splits change. Dividers between neighbours resize them.
 */
export function SplitArea(p: {
  class: string;
  classList?: Record<string, boolean>;
  layout: Layout;
  onResize: (path: number[], sizes: number[]) => void;
  children: (id: number) => JSX.Element;
}) {
  let area!: HTMLDivElement;
  const ids = createMemo(() => p.layout.panes.map((x) => x.id));
  const placed = createMemo(() => arrange(treeOf(p.layout)));
  const pct = (v: number) => `${v * 100}%`;

  const startResize = (e: PointerEvent, d: Divider) => {
    e.preventDefault();
    const split = splitAt(treeOf(p.layout), d.path);
    if (!split) return;
    const sizes = [...split.sizes];
    const start = sizes.slice(0, d.index).reduce((a, b) => a + b, 0);
    const pair = sizes[d.index] + sizes[d.index + 1];
    const rect = area.getBoundingClientRect();
    const row = d.dir === "row";
    const span = row ? rect.width * d.area.w : rect.height * d.area.h;
    const min = Math.min(pair / 2, MIN_PX / span);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add(row ? "resizing-x" : "resizing-y");
    const move = (ev: PointerEvent) => {
      const f = row ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      const local = (f - (row ? d.area.x : d.area.y)) / (row ? d.area.w : d.area.h);
      const first = Math.max(min, Math.min(pair - min, local - start));
      const next = [...sizes];
      next[d.index] = first;
      next[d.index + 1] = pair - first;
      p.onResize(d.path, next);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-x", "resizing-y");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  return (
    <div ref={area} class={`split-area ${p.class}`} classList={p.classList}>
      <For each={ids()}>
        {(id) => {
          const r = () => placed().panes.get(id) ?? { x: 0, y: 0, w: 1, h: 1 };
          return (
            <div
              class="split-pane"
              classList={{ "edge-left": r().x > 0.0001, "edge-top": r().y > 0.0001 }}
              style={{ left: pct(r().x), top: pct(r().y), width: pct(r().w), height: pct(r().h) }}
            >
              {p.children(id)}
            </div>
          );
        }}
      </For>
      <Show when={!drag()}>
        {/* By position, so a divider being dragged keeps its element (and pointer capture). */}
        <Index each={placed().dividers}>
          {(d) => (
            <div
              class={`split-divider ${d().dir}`}
              style={
                d().dir === "row"
                  ? { left: pct(d().at), top: pct(d().area.y), height: pct(d().area.h) }
                  : { top: pct(d().at), left: pct(d().area.x), width: pct(d().area.w) }
              }
              onPointerDown={(e) => startResize(e, d())}
            />
          )}
        </Index>
      </Show>
    </div>
  );
}

/** The dragged tab under the pointer and where it would land. */
export function DragLayer() {
  return (
    <Show when={drag()}>
      {(d) => (
        <>
          <Show when={d().target}>
            {(t) => (
              <div
                class="drop-hint"
                classList={{ slot: t().index != null }}
                style={{
                  left: `${t().box.left}px`,
                  top: `${t().box.top}px`,
                  width: `${t().box.width}px`,
                  height: `${t().box.height}px`,
                }}
              />
            )}
          </Show>
          <div
            class="drag-ghost"
            classList={{ flip: d().x > window.innerWidth - 240 }}
            style={{ left: `${d().x + 12}px`, top: `${d().y + 8}px` }}
          >
            {d().label}
          </div>
        </>
      )}
    </Show>
  );
}
