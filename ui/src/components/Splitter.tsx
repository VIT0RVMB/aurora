import { snapToCells } from "../lib/cells";

interface Props {
  /** Current size in cells. */
  cells: () => number;
  setCells: (n: number) => void;
  /** Cell width for a vertical bar, cell height for a horizontal one. */
  cellW: () => number;
  min: number;
  max: number;
  /** +1 when dragging right/down grows the panel, -1 otherwise. */
  direction: 1 | -1;
  /** "x" resizes columns (default), "y" resizes rows. */
  axis?: "x" | "y";
  onEnd: () => void;
}

/** Drag handle that resizes a panel in whole cells. */
export function Splitter(p: Props) {
  const y = () => p.axis === "y";
  const onPointerDown = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const start = y() ? e.clientY : e.clientX;
    const startPx = p.cells() * p.cellW();
    const move = (ev: PointerEvent) => {
      const px = startPx + ((y() ? ev.clientY : ev.clientX) - start) * p.direction;
      p.setCells(snapToCells(px, p.cellW(), p.min, p.max));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      p.onEnd();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return (
    <div
      class="splitter"
      classList={{ horizontal: y() }}
      role="separator"
      aria-orientation={y() ? "horizontal" : "vertical"}
      onPointerDown={onPointerDown}
    />
  );
}
