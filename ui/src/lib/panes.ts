// Panes for terminals and editor groups, each with its own tabs, arranged in
// a tree of splits (side by side, stacked, nested) like VS Code's grid. An
// item sits in exactly one pane (one xterm or editor view cannot render in
// two places). Pure functions over an immutable layout so the state modules
// stay thin and this is tested.

export interface Pane {
  id: number;
  tabs: string[];
  active: string | null;
}

/** `row`: side by side; `column`: stacked top to bottom. */
export type Dir = "row" | "column";

/** A pane (by id) or a split of nodes along `dir`, sized by fractions summing to 1. */
export type Node = number | Split;
export interface Split {
  dir: Dir;
  children: Node[];
  sizes: number[];
}

export interface Layout {
  /** Every pane, in reading order (left to right, top to bottom). */
  panes: Pane[];
  focused: number;
  /** How the panes are arranged; absent in layouts saved before nesting. */
  tree?: Node;
  /** Layouts saved before nesting: one row or one column. */
  dir?: Dir;
}

/** Where a dragged tab lands on a pane: its middle, or one of its edges (a new split). */
export type Side = "center" | "left" | "right" | "top" | "bottom";

export const emptyLayout = (): Layout => ({ panes: [{ id: 1, tabs: [], active: null }], focused: 1, tree: 1 });

const nextId = (l: Layout) => Math.max(0, ...l.panes.map((p) => p.id)) + 1;
const even = (n: number) => Array.from({ length: n }, () => 1 / n);

export function treeOf(l: Layout): Node {
  if (l.tree != null) return l.tree;
  if (l.panes.length === 1) return l.panes[0].id;
  return { dir: l.dir ?? "row", children: l.panes.map((p) => p.id), sizes: even(l.panes.length) };
}

export function leaves(n: Node): number[] {
  return typeof n === "number" ? [n] : n.children.flatMap(leaves);
}

/** Single-child splits collapse; a split inside one of the same direction merges into it. */
function normalize(n: Node): Node {
  if (typeof n === "number") return n;
  const children: Node[] = [];
  const sizes: number[] = [];
  n.children.forEach((c, i) => {
    const child = normalize(c);
    const size = n.sizes[i] ?? 1 / n.children.length;
    if (typeof child !== "number" && child.dir === n.dir) {
      child.children.forEach((g, j) => {
        children.push(g);
        sizes.push(size * child.sizes[j]);
      });
    } else {
      children.push(child);
      sizes.push(size);
    }
  });
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { dir: n.dir, children, sizes: sizes.map((s) => s / total) };
}

/** Puts pane `id` beside `target` along `dir`, taking half of its room. */
function insertBeside(n: Node, target: number, id: number, dir: Dir, before: boolean): Node {
  if (n === target) {
    return { dir, children: before ? [id, target] : [target, id], sizes: [0.5, 0.5] };
  }
  if (typeof n === "number") return n;
  const at = n.children.indexOf(target);
  if (at >= 0 && n.dir === dir) {
    const children = [...n.children];
    const sizes = [...n.sizes];
    const half = sizes[at] / 2;
    sizes[at] = half;
    children.splice(before ? at : at + 1, 0, id);
    sizes.splice(before ? at : at + 1, 0, half);
    return { ...n, children, sizes };
  }
  return { ...n, children: n.children.map((c) => insertBeside(c, target, id, dir, before)) };
}

function removeLeaf(n: Node, id: number): Node | null {
  if (typeof n === "number") return n === id ? null : n;
  const kept: Node[] = [];
  const sizes: number[] = [];
  n.children.forEach((c, i) => {
    const r = removeLeaf(c, id);
    if (r != null) {
      kept.push(r);
      sizes.push(n.sizes[i]);
    }
  });
  if (!kept.length) return null;
  return normalize({ ...n, children: kept, sizes });
}

/** Rebuilds `panes` in the tree's reading order and keeps the tree tidy. */
function withTree(l: Layout, tree: Node, panes = l.panes, focused = l.focused): Layout {
  const t = normalize(tree);
  const byId = new Map(panes.map((p) => [p.id, p]));
  const ordered = leaves(t).map((id) => byId.get(id)!).filter(Boolean);
  const { dir: _legacy, ...rest } = l;
  return { ...rest, panes: ordered, focused: ordered.some((p) => p.id === focused) ? focused : ordered[0].id, tree: t };
}

export function paneOf(l: Layout, session: string): Pane | undefined {
  return l.panes.find((p) => p.tabs.includes(session));
}

export function focusedPane(l: Layout): Pane {
  return l.panes.find((p) => p.id === l.focused) ?? l.panes[0];
}

/** Opens a session: activates it where it already is, else adds it to the focused pane. */
export function show(l: Layout, session: string): Layout {
  const home = paneOf(l, session);
  if (home) {
    return { ...l, focused: home.id, panes: l.panes.map((p) => (p === home ? { ...p, active: session } : p)) };
  }
  const target = focusedPane(l);
  return {
    ...l,
    focused: target.id,
    panes: l.panes.map((p) => (p === target ? { ...p, tabs: [...p.tabs, session], active: session } : p)),
  };
}

/** Closes a pane, its tabs gone with it; the last pane stays. */
export function removePane(l: Layout, id: number): Layout {
  if (l.panes.length < 2 || !l.panes.some((p) => p.id === id)) return l;
  const order = l.panes.map((p) => p.id);
  const at = order.indexOf(id);
  const focused = l.focused === id ? (order[at - 1] ?? order[at + 1]) : l.focused;
  return withTree(
    l,
    removeLeaf(treeOf(l), id) ?? order.find((x) => x !== id)!,
    l.panes.filter((p) => p.id !== id),
    focused,
  );
}

/** Takes an item out of its pane; an emptied pane closes unless it is the last one. */
function takeOut(l: Layout, item: string, keepPane?: number): Layout {
  const home = paneOf(l, item);
  if (!home) return l;
  const idx = home.tabs.indexOf(item);
  const tabs = home.tabs.filter((t) => t !== item);
  const active = home.active === item ? (tabs[Math.min(idx, tabs.length - 1)] ?? null) : home.active;
  const out = { ...l, panes: l.panes.map((p) => (p === home ? { ...p, tabs, active } : p)) };
  return tabs.length === 0 && home.id !== keepPane ? removePane(out, home.id) : out;
}

/** Removes a session's tab; an emptied pane closes unless it is the last one. */
export function close(l: Layout, session: string): Layout {
  return takeOut(l, session);
}

/**
 * Moves the focused pane's active item into a new pane beside it, along
 * `dir`. With a single tab there is nothing to move: `empty` opens a blank
 * pane instead, else the split is refused (null).
 */
export function split(l: Layout, dir: Dir = "row", empty = false): Layout | null {
  const src = focusedPane(l);
  const moving = src.active && src.tabs.length >= 2 ? src.active : null;
  if (!moving && !empty) return null;
  const id = nextId(l);
  const rest = src.tabs.filter((t) => t !== moving);
  const panes = l.panes.map((p) => (p === src && moving ? { ...p, tabs: rest, active: rest[rest.length - 1] } : p));
  panes.push(moving ? { id, tabs: [moving], active: moving } : { id, tabs: [], active: null });
  return withTree(l, insertBeside(treeOf(l), src.id, id, dir, false), panes, id);
}

/**
 * Moves a tab into pane `to` at `index` (end when omitted), or reorders it
 * inside its own pane. The source pane closes if that emptied it.
 */
export function move(l: Layout, item: string, to: number, index?: number): Layout {
  const from = paneOf(l, item);
  const target = l.panes.find((p) => p.id === to);
  if (!from || !target) return l;
  if (from.id === to) {
    // `index` is a slot in the current order; taking the tab out shifts later slots.
    const tabs = from.tabs.filter((t) => t !== item);
    const before = from.tabs.indexOf(item);
    const slot = index == null ? tabs.length : index > before ? index - 1 : index;
    tabs.splice(Math.min(slot, tabs.length), 0, item);
    return { ...l, focused: to, panes: l.panes.map((p) => (p === from ? { ...p, tabs, active: item } : p)) };
  }
  const out = takeOut(l, item, to);
  return {
    ...out,
    focused: to,
    panes: out.panes.map((p) => {
      if (p.id !== to) return p;
      const tabs = [...p.tabs];
      tabs.splice(Math.min(index ?? tabs.length, tabs.length), 0, item);
      return { ...p, tabs, active: item };
    }),
  };
}

/** Whether dropping `item` on `side` of pane `to` would change anything. */
export function canDrop(l: Layout, item: string, to: number, side: Side): boolean {
  const from = paneOf(l, item);
  if (!from || !l.panes.some((p) => p.id === to)) return false;
  if (side === "center") return from.id !== to;
  // Splitting a pane off its only tab would leave it empty.
  return !(from.id === to && from.tabs.length === 1);
}

/** Drops a tab on a pane: the middle moves it there, an edge splits a new pane off that side. */
export function drop(l: Layout, item: string, to: number, side: Side): Layout {
  if (!canDrop(l, item, to, side)) return l;
  if (side === "center") return move(l, item, to);
  const id = nextId(l);
  const out = takeOut(l, item, to);
  const dir: Dir = side === "left" || side === "right" ? "row" : "column";
  const panes = [...out.panes, { id, tabs: [item], active: item }];
  return withTree(out, insertBeside(treeOf(out), to, id, dir, side === "left" || side === "top"), panes, id);
}

/** Sets the sizes of the split at `path` (child indices from the root). */
export function resize(l: Layout, path: number[], sizes: number[]): Layout {
  const set = (n: Node, depth: number): Node => {
    if (typeof n === "number") return n;
    if (depth === path.length) return { ...n, sizes };
    return { ...n, children: n.children.map((c, i) => (i === path[depth] ? set(c, depth + 1) : c)) };
  };
  return { ...l, tree: set(treeOf(l), 0) };
}

/** Folds every pane back into one, keeping tab order and the active session. */
export function unsplit(l: Layout): Layout {
  const active = focusedPane(l).active;
  const tabs = l.panes.flatMap((p) => p.tabs);
  const id = l.panes[0].id;
  const { dir: _legacy, ...rest } = l;
  return { ...rest, panes: [{ id, tabs, active: active ?? tabs[0] ?? null }], focused: id, tree: id };
}

/** Moves focus to the next (or previous) pane, wrapping around. */
export function focusPane(l: Layout, delta: number): Layout {
  const i = l.panes.findIndex((p) => p.id === l.focused);
  const next = l.panes[(i + delta + l.panes.length) % l.panes.length];
  return { ...l, focused: next.id };
}

/** Focuses a pane by id; unknown ids leave the layout as it is. */
export function focus(l: Layout, id: number): Layout {
  return l.focused === id || !l.panes.some((p) => p.id === id) ? l : { ...l, focused: id };
}

/** Next/previous tab inside the focused pane. */
export function cycle(l: Layout, delta: number): Layout {
  const p = focusedPane(l);
  if (p.tabs.length < 2 || !p.active) return l;
  const i = p.tabs.indexOf(p.active);
  const active = p.tabs[(i + delta + p.tabs.length) % p.tabs.length];
  return { ...l, panes: l.panes.map((x) => (x === p ? { ...x, active } : x)) };
}

/** Drops sessions that no longer exist, e.g. after the daemon restarted. */
export function prune(l: Layout, alive: Set<string>): Layout {
  let out = l;
  for (const p of l.panes) for (const t of p.tabs) if (!alive.has(t)) out = close(out, t);
  return out;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A divider between two neighbours of the split at `path`, for resizing. */
export interface Divider {
  path: number[];
  /** The divider sits after child `index`. */
  index: number;
  dir: Dir;
  /** The split's own rect, and where the line is. */
  area: Rect;
  at: number;
}

/** Where each pane and divider goes, in fractions of the whole area. */
export function arrange(tree: Node): { panes: Map<number, Rect>; dividers: Divider[] } {
  const panes = new Map<number, Rect>();
  const dividers: Divider[] = [];
  const walk = (n: Node, r: Rect, path: number[]) => {
    if (typeof n === "number") return void panes.set(n, r);
    let offset = 0;
    n.children.forEach((c, i) => {
      const s = n.sizes[i];
      const cr =
        n.dir === "row" ? { x: r.x + offset * r.w, y: r.y, w: s * r.w, h: r.h } : { x: r.x, y: r.y + offset * r.h, w: r.w, h: s * r.h };
      walk(c, cr, [...path, i]);
      offset += s;
      if (i < n.children.length - 1) {
        dividers.push({ path, index: i, dir: n.dir, area: r, at: n.dir === "row" ? r.x + offset * r.w : r.y + offset * r.h });
      }
    });
  };
  walk(tree, { x: 0, y: 0, w: 1, h: 1 }, []);
  return { panes, dividers };
}

/** The split node at `path`. */
export function splitAt(tree: Node, path: number[]): Split | null {
  let n: Node = tree;
  for (const i of path) {
    if (typeof n === "number") return null;
    n = n.children[i];
  }
  return typeof n === "number" ? null : n;
}

/** Which part of a pane a point falls in: a quarter-deep band along each edge, else the middle. */
export function sideAt(rx: number, ry: number): Side {
  const edges: [Side, number][] = [
    ["left", rx],
    ["right", 1 - rx],
    ["top", ry],
    ["bottom", 1 - ry],
  ];
  const [side, d] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
  return d < 0.25 ? side : "center";
}
