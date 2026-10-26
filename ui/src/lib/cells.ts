// Panel sizes snap to whole terminal cells so borders land on the grid.

export function snapToCells(px: number, cellW: number, minCells: number, maxCells: number): number {
  const cells = Math.round(px / cellW);
  return Math.min(maxCells, Math.max(minCells, cells));
}

/**
 * One monospace cell in px, measured from the code font, plus the list row
 * height. Also writes the width to `--cell-w` so CSS sizes in cells match.
 */
export function measureCell(el: HTMLElement = document.body): { w: number; h: number; row: number } {
  const probe = document.createElement("span");
  probe.textContent = "M".repeat(100);
  probe.style.cssText =
    "position:absolute;visibility:hidden;white-space:pre;font-family:var(--font-mono);font-size:var(--font-size)";
  el.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 100;
  probe.remove();
  const root = document.documentElement;
  if (w > 0) root.style.setProperty("--cell-w", `${w}px`);
  const css = getComputedStyle(root);
  const h = parseFloat(css.getPropertyValue("--cell-h")) || 20;
  const row = parseFloat(css.getPropertyValue("--row-h")) || 26;
  return { w, h, row };
}

/**
 * xterm.js rounds the cell width down to whole device pixels. At 13px most
 * monospace fonts advance ~7.8px, so cells come out at 7px and every glyph is
 * squeezed into a slot narrower than itself. Nudge the size so the advance
 * lands just above the next whole pixel instead (13px -> ~13.3px, 8px cells).
 */
export function fittedFontSize(base: number, advancePerPx: number, dpr: number): number {
  if (!(advancePerPx > 0)) return base;
  const cell = Math.ceil(base * advancePerPx * dpr - 0.05) / dpr;
  return (cell + 0.01 / dpr) / advancePerPx;
}
