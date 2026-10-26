import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { t, type Key } from "../lib/i18n";
import type { SessionInfo, Stage } from "../lib/ipc";
import { displayName, STAGES, statusView } from "../lib/sessions";
import { ago } from "../lib/text";
import { sessionMenu } from "../state/menus";
import * as sessions from "../state/sessions";
import { notify, now, openDiff, setCenterView } from "../state/ui";

/**
 * Sessions of this workspace by stage. Keys: h/l (or ←/→) pick a column,
 * j/k a card, H/L (or Shift+←/→) move the card, Enter opens it, d shows its
 * diff, Esc leaves.
 * Cards can also be dragged between columns.
 */
export function Kanban() {
  let board!: HTMLDivElement;
  const columns = createMemo(() =>
    STAGES.map((stage) => ({
      stage,
      // A daemon from before stages sends none: those sessions are in the inbox.
      cards: sessions.here().filter((s) => (s.stage ?? "inbox") === stage),
    })),
  );
  const [col, setCol] = createSignal(0);
  const [row, setRow] = createSignal(0);
  const [dragOver, setDragOver] = createSignal<Stage | null>(null);

  const cardAt = (c: number, r: number): SessionInfo | undefined => columns()[c]?.cards[r];
  const clampRow = (c: number, r: number) => Math.max(0, Math.min(r, columns()[c].cards.length - 1));
  const selected = () => cardAt(col(), row());

  const move = async (s: SessionInfo, stage: Stage) => {
    const err = await sessions.setStage(s, stage);
    if (err) notify(err, "error");
  };
  const shift = (d: number) => {
    const s = selected();
    const target = col() + d;
    if (!s || target < 0 || target >= STAGES.length) return;
    void move(s, STAGES[target]).then(() => {
      // Follow the card into its new column.
      setCol(target);
      setRow(Math.max(0, columns()[target].cards.findIndex((x) => x.id === s.id)));
    });
  };

  const onKey = (e: KeyboardEvent) => {
    const k = e.key;
    if (k === "Escape") setCenterView("auto");
    else if (k === "H" || (e.shiftKey && k === "ArrowLeft")) shift(-1);
    else if (k === "L" || (e.shiftKey && k === "ArrowRight")) shift(1);
    else if (k === "h" || k === "ArrowLeft") {
      const c = Math.max(0, col() - 1);
      setCol(c);
      setRow((r) => clampRow(c, r));
    } else if (k === "l" || k === "ArrowRight") {
      const c = Math.min(STAGES.length - 1, col() + 1);
      setCol(c);
      setRow((r) => clampRow(c, r));
    } else if (k === "j" || k === "ArrowDown") setRow((r) => clampRow(col(), r + 1));
    else if (k === "k" || k === "ArrowUp") setRow((r) => clampRow(col(), r - 1));
    else if (k === "Enter") {
      const s = selected();
      if (s) void sessions.focusSession(s.id);
    } else if (k === "d") {
      const s = selected();
      if (s) openDiff(s.id);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  onMount(() => board.focus());

  return (
    <div ref={board} class="kanban" tabindex={0} onKeyDown={onKey}>
      <For each={columns()}>
        {(column, c) => (
          <div
            class="box kanban-col"
            classList={{ drop: dragOver() === column.stage, current: c() === col() }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(column.stage);
            }}
            onDragLeave={() => setDragOver((s) => (s === column.stage ? null : s))}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(null);
              const s = sessions.byId(e.dataTransfer?.getData("text/aurora-session") ?? "");
              if (s) void move(s, column.stage);
            }}
          >
            <div class="box-title">
              {t(`stage.${column.stage}` as Key)}
              <span class="count">{column.cards.length}</span>
            </div>
            <div class="kanban-cards">
              <For each={column.cards} fallback={<div class="kanban-empty">·</div>}>
                {(s, r) => {
                  const view = () => statusView(s);
                  return (
                    <button
                      class="kanban-card"
                      classList={{ selected: c() === col() && r() === row(), colored: !!s.color }}
                      style={s.color ? { "--sc": `var(--sc-${s.color})` } : undefined}
                      onContextMenu={(e) => sessionMenu(e, s)}
                      draggable={true}
                      tabindex={-1}
                      title={s.worktree ?? s.cwd}
                      onDragStart={(e) => e.dataTransfer?.setData("text/aurora-session", s.id)}
                      onClick={() => {
                        setCol(c());
                        setRow(r());
                        board.focus();
                      }}
                      onDblClick={() => void sessions.focusSession(s.id)}
                    >
                      <div class="kanban-line">
                        <span class={view().tone}>{view().glyph}</span>
                        <span class="kanban-name">{displayName(s)}</span>
                        <span class="kanban-age">{ago(s.updatedMs, now())}</span>
                      </div>
                      <div class="kanban-line kanban-meta">
                        <span>{s.agent}</span>
                        <Show when={s.branch}>
                          <span class="faint">⎇</span>
                          <span class="kanban-branch">{s.branch}</span>
                        </Show>
                      </div>
                      <div class="kanban-line kanban-meta">
                        <span class={view().tone}>{view().label}</span>
                      </div>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
