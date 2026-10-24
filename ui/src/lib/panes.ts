// Terminal panes: side-by-side splits, each with its own tabs. A session sits
// in exactly one pane (one xterm cannot render in two places). Pure functions
// over an immutable layout so the state module stays thin and this is tested.

export interface Pane {
  id: number;
  tabs: string[];
  active: string | null;
}

export interface Layout {
  panes: Pane[];
  focused: number;
}

export const emptyLayout = (): Layout => ({ panes: [{ id: 1, tabs: [], active: null }], focused: 1 });

const nextId = (l: Layout) => Math.max(0, ...l.panes.map((p) => p.id)) + 1;

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
    return { focused: home.id, panes: l.panes.map((p) => (p === home ? { ...p, active: session } : p)) };
  }
  const target = focusedPane(l);
  return {
    focused: target.id,
    panes: l.panes.map((p) => (p === target ? { ...p, tabs: [...p.tabs, session], active: session } : p)),
  };
}

/** Removes a session's tab; an emptied pane closes unless it is the last one. */
export function close(l: Layout, session: string): Layout {
  const home = paneOf(l, session);
  if (!home) return l;
  const idx = home.tabs.indexOf(session);
  const tabs = home.tabs.filter((t) => t !== session);
  const active = home.active === session ? (tabs[Math.min(idx, tabs.length - 1)] ?? null) : home.active;
  let panes = l.panes.map((p) => (p === home ? { ...p, tabs, active } : p));
  let focused = l.focused;
  if (tabs.length === 0 && panes.length > 1) {
    const at = panes.findIndex((p) => p.id === home.id);
    panes = panes.filter((p) => p.id !== home.id);
    if (focused === home.id) focused = panes[Math.max(0, at - 1)].id;
  }
  return { panes, focused };
}

/** Moves the focused pane's active session into a new pane to its right. */
export function split(l: Layout): Layout | string {
  const src = focusedPane(l);
  if (!src.active || src.tabs.length < 2) return "abra outra sessão neste painel para dividir";
  const moving = src.active;
  const rest = src.tabs.filter((t) => t !== moving);
  const id = nextId(l);
  const panes: Pane[] = [];
  for (const p of l.panes) {
    if (p === src) {
      panes.push({ ...p, tabs: rest, active: rest[rest.length - 1] });
      panes.push({ id, tabs: [moving], active: moving });
    } else panes.push(p);
  }
  return { panes, focused: id };
}

/** Folds every pane back into one, keeping tab order and the active session. */
export function unsplit(l: Layout): Layout {
  const active = focusedPane(l).active;
  const tabs = l.panes.flatMap((p) => p.tabs);
  const id = l.panes[0].id;
  return { panes: [{ id, tabs, active: active ?? tabs[0] ?? null }], focused: id };
}

export function focusPane(l: Layout, delta: number): Layout {
  const i = l.panes.findIndex((p) => p.id === l.focused);
  const next = l.panes[(i + delta + l.panes.length) % l.panes.length];
  return { ...l, focused: next.id };
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
