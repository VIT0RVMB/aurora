import { describe, expect, it } from "vitest";
import { fittedFontSize, snapToCells } from "./cells";

describe("snapToCells", () => {
  it("rounds and clamps to cell counts", () => {
    expect(snapToCells(160, 8, 10, 60)).toBe(20);
    expect(snapToCells(163, 8, 10, 60)).toBe(20);
    expect(snapToCells(10, 8, 10, 60)).toBe(10);
    expect(snapToCells(9999, 8, 10, 60)).toBe(60);
  });
});

describe("fittedFontSize", () => {
  // xterm floors the cell to whole device pixels; the glyph must fit in it.
  const cellPx = (size: number, adv: number, dpr: number) => Math.floor(size * adv * dpr);
  it("moves the advance just above the next whole pixel", () => {
    for (const adv of [0.6, 0.602, 0.55]) {
      for (const dpr of [1, 2, 1.5]) {
        const size = fittedFontSize(13, adv, dpr);
        expect(size).toBeGreaterThanOrEqual(13);
        expect(size).toBeLessThan(13 + 2 / adv);
        // The floored cell holds the whole glyph.
        expect(cellPx(size, adv, dpr)).toBeGreaterThanOrEqual(13 * adv * dpr);
      }
    }
  });
  it("keeps the size when it already lands on a pixel or the font is unknown", () => {
    expect(fittedFontSize(10, 0.6, 1)).toBeCloseTo(10.017, 2);
    expect(fittedFontSize(13, 0, 1)).toBe(13);
  });
});
