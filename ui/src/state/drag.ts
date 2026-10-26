// Dragging tabs between panes, VS Code style: onto a tab strip (that slot),
// a pane's middle (into it) or a pane's edge (a new split there). Pointer
// events rather than HTML5 drag and drop: editors and terminals have their
// own drop handling, and the webview may claim native drops for files.
import { createSignal } from "solid-js";
import { sideAt, type Side } from "../lib/panes";

/** Editor tabs go to editor groups, sessions to terminal panes. */
export type DragKind = "editor" | "session";

export interface DropTarget {
  pane: number;
  /** A slot in the pane's tab strip, or a part of the pane. */
  index?: number;
  side?: Side;
  /** A session dropped on an edge of the editor: the terminal area moves to that side. */
  dock?: Exclude<Side, "center">;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Drag {
  kind: DragKind;
  label: string;
  x: number;
  y: number;
  /** Where it would land, drawn by the drag layer. */
  target: (DropTarget & { box: Box }) | null;
}

export const [drag, setDrag] = createSignal<Drag | null>(null);

const START_PX = 4;

function toBox(r: DOMRect): Box {
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function sideBox(r: DOMRect, side: Side): Box {
  const b = toBox(r);
  if (side === "left") return { ...b, width: b.width / 2 };
  if (side === "right") return { ...b, left: b.left + b.width / 2, width: b.width / 2 };
  if (side === "top") return { ...b, height: b.height / 2 };
  if (side === "bottom") return { ...b, top: b.top + b.height / 2, height: b.height / 2 };
  return b;
}

function hitTest(x: number, y: number, kind: DragKind, ok: (t: DropTarget) => boolean): Drag["target"] {
  const el = document.elementFromPoint(x, y);
  const strip = el?.closest<HTMLElement>(`[data-tabs-pane][data-kind="${kind}"]`);
  if (strip) {
    const pane = Number(strip.dataset.tabsPane);
    const tabs = [...strip.querySelectorAll<HTMLElement>(".tab")];
    const index = tabs.filter((t) => {
      const r = t.getBoundingClientRect();
      return r.left + r.width / 2 < x;
    }).length;
    const t = { pane, index };
    if (!ok(t)) return null;
    const r = strip.getBoundingClientRect();
    const edge = tabs[index]?.getBoundingClientRect().left ?? (tabs.at(-1)?.getBoundingClientRect().right ?? r.left);
    return { ...t, box: { left: edge - 1, top: r.top, width: 2, height: r.height } };
  }
  const paneEl = el?.closest<HTMLElement>(`[data-drop-pane][data-kind="${kind}"]`);
  if (!paneEl) return kind === "session" ? dockTest(el, x, y, ok) : null;
  const r = paneEl.getBoundingClientRect();
  const side = sideAt((x - r.left) / r.width, (y - r.top) / r.height);
  const t = { pane: Number(paneEl.dataset.dropPane), side };
  return ok(t) ? { ...t, box: sideBox(r, side) } : null;
}

/** Over the editor, near an edge: where the terminal area would go, shown as its future band. */
function dockTest(el: Element | null, x: number, y: number, ok: (t: DropTarget) => boolean): Drag["target"] {
  const editor = el?.closest<HTMLElement>("[data-dock-area]");
  const root = editor?.closest<HTMLElement>("[data-dock-root]");
  if (!editor || !root) return null;
  const r = editor.getBoundingClientRect();
  const side = sideAt((x - r.left) / r.width, (y - r.top) / r.height);
  if (side === "center") return null;
  const t: DropTarget = { pane: -1, dock: side };
  if (!ok(t)) return null;
  const c = root.getBoundingClientRect();
  const band = 0.4;
  const box =
    side === "left" ? { left: c.left, top: c.top, width: c.width * band, height: c.height }
    : side === "right" ? { left: c.right - c.width * band, top: c.top, width: c.width * band, height: c.height }
    : side === "top" ? { left: c.left, top: c.top, width: c.width, height: c.height * band }
    : { left: c.left, top: c.bottom - c.height * band, width: c.width, height: c.height * band };
  return { ...t, box };
}

/**
 * Called from a tab's pointerdown. Past a few pixels it becomes a drag; a
 * plain click stays a click. Esc cancels.
 */
export function startTabDrag(
  e: PointerEvent,
  o: { kind: DragKind; label: string; canDrop: (t: DropTarget) => boolean; onDrop: (t: DropTarget) => void },
) {
  if (e.button !== 0) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let active = false;
  const move = (ev: PointerEvent) => {
    if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < START_PX) return;
    if (!active) {
      active = true;
      document.body.classList.add("dragging");
    }
    setDrag({ kind: o.kind, label: o.label, x: ev.clientX, y: ev.clientY, target: hitTest(ev.clientX, ev.clientY, o.kind, o.canDrop) });
  };
  const end = (commit: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("keydown", key, true);
    document.body.classList.remove("dragging");
    const t = drag()?.target;
    setDrag(null);
    if (commit && active && t) o.onDrop({ pane: t.pane, index: t.index, side: t.side, dock: t.dock });
  };
  const up = () => end(true);
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    end(false);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("keydown", key, true);
}
