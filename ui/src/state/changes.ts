// What each session of the workspace changed: its diff list and the tree marks.
// Refreshed when a session reports activity and when workspace files change.
import { createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { core, type SessionChanges } from "../lib/ipc";
import { buildMarks } from "../lib/marks";
import { displayName } from "../lib/sessions";
import * as sessions from "./sessions";

const [changes, setChanges] = createStore<Record<string, SessionChanges | undefined>>({});
export { changes };

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Asks the core again, soon: hooks and file events come in bursts. */
export function refresh(id: string, delay = 400) {
  clearTimeout(timers.get(id));
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      void core
        .sessionChanges(id)
        .then((c) => setChanges(id, reconcile(c)))
        .catch(() => setChanges(id, undefined));
    }, delay),
  );
}

/** Bumped on every workspace file change, for views that recount (the home's worktrees). */
export const [fsTick, setFsTick] = createSignal(0);

/** Workspace files changed: sessions working in the workspace may own some of it. */
export function onFsBatch() {
  setFsTick((n) => n + 1);
  for (const s of sessions.here()) if (!s.worktree) refresh(s.id, 800);
}

export const marks = createRoot(() => {
  // Agent activity (status, hooks) moves `updatedMs`; that is when files change.
  createEffect(
    on(
      () => sessions.here().map((s) => `${s.id}:${s.updatedMs}:${s.status}`).join(),
      () => {
        const ids = new Set(sessions.here().map((s) => s.id));
        for (const id of ids) refresh(id);
        for (const id of Object.keys(changes)) if (!ids.has(id)) setChanges(id, undefined);
      },
    ),
  );
  return createMemo(() =>
    buildMarks(sessions.here().map((s) => ({ name: displayName(s), files: changes[s.id]?.files ?? [] }))),
  );
});
