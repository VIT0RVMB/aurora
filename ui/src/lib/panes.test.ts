import { describe, expect, it } from "vitest";
import {
  arrange,
  canDrop,
  close,
  cycle,
  drop,
  emptyLayout,
  move,
  prune,
  removePane,
  resize,
  show,
  sideAt,
  split,
  treeOf,
  unsplit,
  type Layout,
} from "./panes";

const open = (...ids: string[]) => ids.reduce<Layout>((l, id) => show(l, id), emptyLayout());
const tabs = (l: Layout) => l.panes.map((p) => p.tabs);

describe("panes", () => {
  it("adds to the focused pane and re-activates existing tabs", () => {
    const l = show(open("a", "b"), "a");
    expect(l.panes).toEqual([{ id: 1, tabs: ["a", "b"], active: "a" }]);
  });

  it("splits the active session into a new pane, and refuses with one tab", () => {
    expect(split(open("a"))).toBeNull();
    const l = split(open("a", "b")) as Layout;
    expect(tabs(l)).toEqual([["a"], ["b"]]);
    expect(l.focused).toBe(2);
    expect(l.tree).toEqual({ dir: "row", children: [1, 2], sizes: [0.5, 0.5] });
    // New sessions land in the focused (new) pane.
    expect(show(l, "c").panes[1].tabs).toEqual(["b", "c"]);
  });

  it("nests a split of the other direction inside the pane it splits", () => {
    let l = split(open("a", "b", "c")) as Layout; // [a b] | [c]
    l = split(show(l, "b"), "column") as Layout; // b goes below a
    expect(l.tree).toEqual({ dir: "row", children: [{ dir: "column", children: [1, 3], sizes: [0.5, 0.5] }, 2], sizes: [0.5, 0.5] });
    expect(tabs(l)).toEqual([["a"], ["b"], ["c"]]);
    // A same-direction split joins the existing row instead of nesting.
    l = split(show(show(l, "c"), "d"), "row") as Layout;
    expect(treeOf(l)).toEqual({
      dir: "row",
      children: [{ dir: "column", children: [1, 3], sizes: [0.5, 0.5] }, 2, 4],
      sizes: [0.5, 0.25, 0.25],
    });
  });

  it("reads layouts saved before nesting", () => {
    const old: Layout = {
      panes: [
        { id: 1, tabs: ["a"], active: "a" },
        { id: 2, tabs: ["b"], active: "b" },
      ],
      focused: 1,
      dir: "column",
    };
    expect(treeOf(old)).toEqual({ dir: "column", children: [1, 2], sizes: [0.5, 0.5] });
    expect(close(old, "b").tree).toBe(1);
  });

  it("opens an empty pane when asked and there is one tab", () => {
    const l = split(open("a"), "row", true) as Layout;
    expect(l.panes).toEqual([
      { id: 1, tabs: ["a"], active: "a" },
      { id: 2, tabs: [], active: null },
    ]);
    expect(l.focused).toBe(2);
    expect(show(l, "b").panes[1].tabs).toEqual(["b"]);
  });

  it("closes emptied panes but keeps the last one, collapsing the tree", () => {
    const l = split(open("a", "b")) as Layout;
    const after = close(l, "b");
    expect(after.panes).toEqual([{ id: 1, tabs: ["a"], active: "a" }]);
    expect(after.tree).toBe(1);
    expect(after.focused).toBe(1);
    expect(close(after, "a").panes).toEqual([{ id: 1, tabs: [], active: null }]);
    expect(removePane(l, 2).panes.map((p) => p.id)).toEqual([1]);
  });

  it("unsplits, cycles and prunes", () => {
    const l = split(open("a", "b", "c")) as Layout;
    expect(unsplit(l).panes).toEqual([{ id: 1, tabs: ["a", "b", "c"], active: "c" }]);
    expect(unsplit(l).tree).toBe(1);
    expect(cycle(open("a", "b", "c"), 1).panes[0].active).toBe("a");
    expect(prune(l, new Set(["a"])).panes).toEqual([{ id: 1, tabs: ["a"], active: "a" }]);
  });
});

describe("drag and drop", () => {
  it("moves a tab to another pane at an index, closing the emptied source", () => {
    const l = split(open("a", "b", "c")) as Layout; // [a b] | [c]
    const m = move(l, "a", 2, 0);
    expect(tabs(m)).toEqual([["b"], ["a", "c"]]);
    expect(m.focused).toBe(2);
    expect(m.panes[1].active).toBe("a");
    const gone = move(m, "b", 2);
    expect(tabs(gone)).toEqual([["a", "c", "b"]]);
    expect(gone.tree).toBe(2);
  });

  it("reorders inside a pane", () => {
    const l = open("a", "b", "c");
    expect(tabs(move(l, "a", 1, 3))).toEqual([["b", "c", "a"]]);
    expect(tabs(move(l, "c", 1, 0))).toEqual([["c", "a", "b"]]);
    expect(tabs(move(l, "a", 1, 2))).toEqual([["b", "a", "c"]]);
  });

  it("splits a pane off any edge, nesting across directions", () => {
    const l = open("a", "b");
    const below = drop(l, "b", 1, "bottom");
    expect(below.tree).toEqual({ dir: "column", children: [1, 2], sizes: [0.5, 0.5] });
    expect(tabs(below)).toEqual([["a"], ["b"]]);
    const left = drop(open("a", "b", "c"), "c", 1, "left");
    expect(tabs(left)).toEqual([["c"], ["a", "b"]]);
    // Off the top pane onto the right of the bottom one: a row inside the column.
    const nested = drop(show(below, "c"), "c", 2, "right");
    expect(nested.tree).toEqual({
      dir: "column",
      children: [1, { dir: "row", children: [2, 3], sizes: [0.5, 0.5] }],
      sizes: [0.5, 0.5],
    });
    // Its only tab gone, the top pane closes and the column collapses.
    expect(drop(nested, "a", 3, "center").tree).toEqual({ dir: "row", children: [2, 3], sizes: [0.5, 0.5] });
  });

  it("refuses drops that change nothing", () => {
    const l = open("a", "b");
    expect(canDrop(l, "a", 1, "center")).toBe(false);
    expect(canDrop(open("a"), "a", 1, "right")).toBe(false);
    expect(canDrop(l, "a", 1, "right")).toBe(true);
    expect(drop(open("a"), "a", 1, "left")).toEqual(open("a"));
  });

  it("resizes a split and lays out rects and dividers", () => {
    const l = drop(drop(open("a", "b", "c"), "c", 1, "right"), "b", 2, "bottom"); // [a] | [c / b]
    const r = resize(l, [], [0.25, 0.75]);
    const { panes, dividers } = arrange(treeOf(r));
    expect(panes.get(1)).toEqual({ x: 0, y: 0, w: 0.25, h: 1 });
    expect(panes.get(2)).toEqual({ x: 0.25, y: 0, w: 0.75, h: 0.5 });
    expect(panes.get(3)).toEqual({ x: 0.25, y: 0.5, w: 0.75, h: 0.5 });
    expect(dividers.map((d) => [d.path, d.dir, d.at])).toEqual([
      [[], "row", 0.25],
      [[1], "column", 0.5],
    ]);
  });

  it("picks a side from where the pointer is", () => {
    expect(sideAt(0.5, 0.5)).toBe("center");
    expect(sideAt(0.1, 0.5)).toBe("left");
    expect(sideAt(0.95, 0.9)).toBe("right");
    expect(sideAt(0.5, 0.8)).toBe("bottom");
  });
});
