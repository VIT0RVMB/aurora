import { describe, expect, it } from "vitest";
import { cellEdit, emptyRow, escapeCell, narrow, parseTableLayout } from "./markdown-table";

const apply = (src: string, e: { from: number; to: number; insert: string }) =>
  src.slice(0, e.from) + e.insert + src.slice(e.to);

describe("table layout", () => {
  const src = "| name | status \\| note | n |\n|:--|:-:|--:|\n| a.rs | added |  |\n| b.ts | x";

  it("finds every cell's text, alignment and short rows", () => {
    const t = parseTableLayout(src);
    expect(t.head.cells.map((c) => c.text)).toEqual(["name", "status | note", "n"]);
    expect(t.align).toEqual(["left", "center", "right"]);
    expect(t.rows.map((r) => r.cells.map((c) => c.text))).toEqual([["a.rs", "added", ""], ["b.ts", "x"]]);
    const c = t.rows[0].cells[0];
    expect(src.slice(c.from, c.to)).toBe("a.rs");
  });

  it("rewrites only the edited cell", () => {
    const t = parseTableLayout(src);
    expect(apply(src, cellEdit(t, 1, 1, "changed"))).toBe(src.replace("| added |", "| changed |"));
    // An empty cell gets its text after the pipe's space.
    expect(apply(src, cellEdit(t, 1, 2, "7"))).toContain("| a.rs | added | 7 |");
    expect(apply(src, cellEdit(t, 0, 0, "a|b"))).toContain("| a\\|b | status");
  });

  it("narrows an edit to what changed", () => {
    expect(narrow("| ab |", { from: 2, to: 4, insert: "abc" })).toEqual({ from: 4, to: 4, insert: "c" });
    expect(narrow("| abc |", { from: 2, to: 5, insert: "ac" })).toEqual({ from: 3, to: 4, insert: "" });
    expect(narrow("| aa |", { from: 2, to: 4, insert: "aaa" })).toEqual({ from: 4, to: 4, insert: "a" });
  });

  it("writes a short row out again when a missing cell is typed in", () => {
    const t = parseTableLayout(src);
    expect(apply(src, cellEdit(t, 2, 2, "9")).split("\n")[3]).toBe("| b.ts | x | 9 |");
  });

  it("handles rows without outer pipes and new rows", () => {
    const t = parseTableLayout("a | b\n--|--\n1 | 2");
    expect(t.rows[0].cells.map((c) => c.text)).toEqual(["1", "2"]);
    const grown = "| a | b |\n|---|---|" + emptyRow(2);
    expect(parseTableLayout(grown).rows[0].cells.map((c) => c.text)).toEqual(["", ""]);
    expect(escapeCell("x\ny|z")).toBe("x y\\|z");
  });
});
