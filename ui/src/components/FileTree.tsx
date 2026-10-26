import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { t } from "../lib/i18n";
import { MARK_GLYPH } from "../lib/marks";
import { flattenTree, parentPath } from "../lib/tree";
import { marks } from "../state/changes";
import { fileMenu } from "../state/menus";
import { openFile } from "../state/editor";
import { treeFocus } from "../state/ui";
import { select, setExpanded, tree, workspace } from "../state/workspace";

const OVERSCAN = 10;

/** What sessions changed here: `+ ~ −` on files, `•` on folders holding some. */
function TreeMark(p: { path: string; dir: boolean }) {
  const file = () => (p.dir ? undefined : marks().files.get(p.path));
  const names = () => (p.dir ? marks().dirs.get(p.path) : file()?.sessions);
  return (
    <Show when={names()}>
      {(n) => (
        <span
          class={`tree-mark ${file()?.kind ?? "dir"}`}
          title={t("tree.changedBy", { names: n().join(", ") })}
        >
          {file() ? MARK_GLYPH[file()!.kind] : "•"}
        </span>
      )}
    </Show>
  );
}

/** Virtualized tree: only the rows in view are in the DOM, so 50k files cost the same as 50. */
export function FileTree(p: { rowH: () => number }) {
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(0);

  const expandedSet = createMemo(() => new Set(Object.keys(tree.expanded).filter((k) => tree.expanded[k])));
  const rows = createMemo(() => flattenTree(tree.children, expandedSet()));
  const selectedIndex = createMemo(() => rows().findIndex((r) => r.entry.path === tree.selected));

  const visible = createMemo(() => {
    const h = p.rowH();
    const start = Math.max(0, Math.floor(scrollTop() / h) - OVERSCAN);
    const end = Math.min(rows().length, Math.ceil((scrollTop() + height()) / h) + OVERSCAN);
    return rows()
      .slice(start, end)
      .map((row, i) => ({ row, index: start + i }));
  });

  onMount(() => {
    const ro = new ResizeObserver(() => setHeight(scroller.clientHeight));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });

  createEffect(on(treeFocus, (n) => n > 0 && scroller.focus(), { defer: true }));

  // Keep the selection in view when it moves (keyboard or editor reveal).
  createEffect(() => {
    const i = selectedIndex();
    if (i < 0) return;
    const h = p.rowH();
    const top = i * h;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + h > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + h - scroller.clientHeight;
  });

  const activateRow = (i: number) => {
    const r = rows()[i];
    if (!r) return;
    select(r.entry.path);
    if (r.entry.isDir) setExpanded(r.entry.path, !r.expanded);
    else void openFile(r.entry.path);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const list = rows();
    if (!list.length) return;
    const i = Math.max(0, selectedIndex());
    const r = list[i];
    const pageRows = Math.max(1, Math.floor(height() / p.rowH()) - 1);
    const moveTo = (n: number) => select(list[Math.min(list.length - 1, Math.max(0, n))].entry.path);
    switch (e.key) {
      case "ArrowDown":
      case "j":
        moveTo(selectedIndex() < 0 ? 0 : i + 1);
        break;
      case "ArrowUp":
      case "k":
        moveTo(i - 1);
        break;
      case "PageDown":
        moveTo(i + pageRows);
        break;
      case "PageUp":
        moveTo(i - pageRows);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(list.length - 1);
        break;
      case "ArrowRight":
      case "l":
        if (r.entry.isDir && !r.expanded) setExpanded(r.entry.path, true);
        else if (r.entry.isDir) moveTo(i + 1);
        break;
      case "ArrowLeft":
      case "h":
        if (r.entry.isDir && r.expanded) setExpanded(r.entry.path, false);
        else {
          const parent = parentPath(r.entry.path);
          if (parent) select(parent);
        }
        break;
      case "Enter":
      case " ":
        activateRow(i);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <section class="tree">
      <div class="box">
        <div class="box-title">
          <span class="accent">◇</span> {workspace()?.name ?? "files"}
        </div>
      <div
        ref={scroller}
        class="tree-scroll"
        tabIndex={0}
        onScroll={() => setScrollTop(scroller.scrollTop)}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => fileMenu(e, null)}
      >
        <div style={{ height: `${rows().length * p.rowH()}px`, position: "relative" }}>
          <For each={visible()}>
            {({ row, index }) => (
              <div
                class="tree-row"
                classList={{ selected: row.entry.path === tree.selected, dir: row.entry.isDir }}
                style={{ top: `${index * p.rowH()}px`, "padding-left": `calc(${row.depth * 2 + 1} * var(--cell-w))` }}
                onClick={() => activateRow(index)}
                onContextMenu={(e) => {
                  select(row.entry.path);
                  fileMenu(e, row.entry);
                }}
                title={row.entry.path}
              >
                <span class="tree-glyph" classList={{ chevron: row.entry.isDir, open: row.expanded }} />
                <span class="tree-name">{row.entry.name}</span>
                <Show when={row.loading}>
                  <span class="faint"> …</span>
                </Show>
                <TreeMark path={row.entry.path} dir={row.entry.isDir} />
              </div>
            )}
          </For>
        </div>
      </div>
      </div>
    </section>
  );
}
