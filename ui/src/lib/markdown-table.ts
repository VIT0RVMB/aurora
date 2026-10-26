// Tables in rich markdown stay rendered while you edit them: every cell is
// editable and each keystroke rewrites just that cell in the source, so undo,
// dirty state and saving work as for any other edit. A table can still be
// switched to its source (the `‹›` button), one table at a time.
import { redo, undo } from "@codemirror/commands";
import { Annotation, type EditorState, StateEffect, StateField } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

export type Align = "left" | "center" | "right" | null;

export interface CellRange {
  /** Offsets of the cell's text inside the table source (trimmed). */
  from: number;
  to: number;
  text: string;
}

export interface RowRange {
  from: number;
  to: number;
  cells: CellRange[];
}

export interface TableLayout {
  head: RowRange;
  align: Align[];
  rows: RowRange[];
}

const unescape = (s: string) => s.replace(/\\\|/g, "|");

/**
 * What typing into a cell writes: one line, pipes escaped, no outer spaces
 * (the cell being typed in keeps showing them until the next character).
 */
export function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, " ").trim().replace(/(?<!\\)\|/g, "\\|");
}

/** Cells of one row, with where each one's text sits; outer pipes are optional. */
function scanRow(line: string, offset: number): RowRange {
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "|") pipes.push(i);
  }
  const bounds = [...pipes];
  if (!pipes.length || line.slice(0, pipes[0]).trim()) bounds.unshift(-1);
  const last = pipes[pipes.length - 1];
  if (!pipes.length || line.slice(last + 1).trim() || bounds.length < 2) bounds.push(line.length);
  const cells: CellRange[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const segFrom = bounds[k] + 1;
    const segTo = bounds[k + 1];
    const raw = line.slice(segFrom, segTo);
    const lead = raw.length - raw.trimStart().length;
    let from = segFrom + lead;
    let to = segTo - (raw.length - raw.trimEnd().length);
    // An empty cell: text goes after the space that follows the pipe.
    if (from >= to) from = to = segFrom + Math.min(1, raw.length);
    cells.push({ from: offset + from, to: offset + to, text: unescape(line.slice(from, to)) });
  }
  return { from: offset, to: offset + line.length, cells };
}

export function parseTableLayout(src: string): TableLayout {
  const rows: RowRange[] = [];
  let at = 0;
  let align: Align[] = [];
  src.split("\n").forEach((line, i) => {
    if (i === 1) {
      align = scanRow(line, at).cells.map(({ text: d }) => {
        const l = d.startsWith(":");
        const r = d.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : null;
      });
    } else if (line.trim()) rows.push(scanRow(line, at));
    at += line.length + 1;
  });
  return { head: rows[0] ?? { from: 0, to: 0, cells: [] }, align, rows: rows.slice(1) };
}

/** The change that puts `text` in cell (`r`, `c`); row 0 is the header. Offsets are table-relative. */
export function cellEdit(layout: TableLayout, r: number, c: number, text: string): { from: number; to: number; insert: string } {
  const row = r === 0 ? layout.head : layout.rows[r - 1];
  const cell = row.cells[c];
  if (cell) return { from: cell.from, to: cell.to, insert: escapeCell(text) };
  // A short row (GFM allows them): written out again with the missing cells.
  const texts = layout.head.cells.map((_, i) => (i === c ? text : (row.cells[i]?.text ?? "")));
  return { from: row.from, to: row.to, insert: `| ${texts.map(escapeCell).join(" | ")} |` };
}

/**
 * Narrows a replacement to the part that differs, so typing at the end of a
 * cell is an insertion there: the history groups it like ordinary typing.
 */
export function narrow(doc: string, e: { from: number; to: number; insert: string }) {
  const old = doc.slice(e.from, e.to);
  let start = 0;
  while (start < old.length && start < e.insert.length && old[start] === e.insert[start]) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < e.insert.length - start &&
    old[old.length - 1 - end] === e.insert[e.insert.length - 1 - end]
  ) end++;
  return { from: e.from + start, to: e.to - end, insert: e.insert.slice(start, e.insert.length - end) };
}

/** An empty row to append after the table's last line. */
export function emptyRow(cols: number): string {
  return `\n|${"   |".repeat(Math.max(1, cols))}`;
}

// ── which tables show their source ──────────────────────────────────────────

export const toggleTableSource = StateEffect.define<number>();

/** Start positions of tables switched to source, kept in place as the text changes. */
export const tableSource = StateField.define<number[]>({
  create: () => [],
  update(list, tr) {
    let next = tr.docChanged ? list.map((p) => tr.changes.mapPos(p)) : list;
    for (const e of tr.effects) {
      if (e.is(toggleTableSource)) next = next.includes(e.value) ? next.filter((p) => p !== e.value) : [...next, e.value];
    }
    return next;
  },
});

/** Set on the selection change that stepped onto a rendered block from above or below. */
export const enteredBlock = Annotation.define<"down" | "up">();

// ── the widget ──────────────────────────────────────────────────────────────

function tableDomAt(view: EditorView, from: number): HTMLElement | null {
  for (const el of view.contentDOM.querySelectorAll<HTMLElement>(".cm-md-table-wrap")) {
    if (view.posAtDOM(el) === from) return el;
  }
  return null;
}

function focusCell(view: EditorView, from: number, r: number, c: number, atEnd = true) {
  const wrap = tableDomAt(view, from);
  const cell = wrap?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`);
  if (!cell) return false;
  cell.focus();
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(!atEnd);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return true;
}

/** Where the caret sits in a cell, as an offset into its text. */
function caretOffset(cell: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !cell.contains(sel.anchorNode)) return 0;
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.setEnd(sel.anchorNode!, sel.anchorOffset);
  return range.toString().length;
}

interface WrapState {
  widget: TableWidget;
  /** The cell whose own input caused the update in flight; its DOM is already right. */
  typing: HTMLElement | null;
}
const wraps = new WeakMap<HTMLElement, WrapState>();

export class TableWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }

  eq(o: TableWidget) {
    return o.src === this.src;
  }

  get layout(): TableLayout {
    return parseTableLayout(this.src);
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    const state: WrapState = { widget: this, typing: null };
    wraps.set(wrap, state);
    this.build(wrap);

    const at = (el: EventTarget | null) => {
      const cell = el instanceof HTMLElement ? el.closest<HTMLElement>("[data-r]") : null;
      return cell ? { cell, r: Number(cell.dataset.r), c: Number(cell.dataset.c) } : null;
    };
    const from = () => view.posAtDOM(wrap);
    const layout = () => state.widget.layout;
    const rowCount = () => layout().rows.length + 1;
    const cols = () => layout().head.cells.length;
    const leave = (dir: "up" | "down") => {
      const doc = view.state.doc;
      const start = doc.lineAt(from());
      const end = doc.lineAt(from() + state.widget.src.length);
      const target =
        dir === "up" ? (start.number > 1 ? doc.line(start.number - 1).from : start.from)
        : end.number < doc.lines ? doc.line(end.number + 1).from : end.to;
      view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
      view.focus();
    };
    // The position is read now: an edit may replace this DOM before the frame.
    const go = (r: number, c: number, atEnd = true) => {
      const base = from();
      requestAnimationFrame(() => focusCell(view, base, r, c, atEnd));
    };

    wrap.addEventListener("input", (e) => {
      const hit = at(e.target);
      if (!hit) return;
      const base = from();
      const change = narrow(state.widget.src, cellEdit(layout(), hit.r, hit.c, hit.cell.textContent ?? ""));
      if (change.from === change.to && !change.insert) return;
      state.typing = hit.cell;
      view.dispatch({
        changes: { from: base + change.from, to: base + change.to, insert: change.insert },
        userEvent: "input.type",
      });
      state.typing = null;
    });

    wrap.addEventListener("keydown", (e) => {
      const hit = at(e.target);
      if (!hit) return;
      const { r, c, cell } = hit;
      const mod = e.metaKey || e.ctrlKey;
      const text = cell.textContent ?? "";
      let handled = true;
      if (e.key === "Tab") {
        const i = r * cols() + c + (e.shiftKey ? -1 : 1);
        if (i < 0) leave("up");
        else if (i >= rowCount() * cols()) leave("down");
        else go(Math.floor(i / cols()), i % cols());
      } else if (e.key === "Enter" && !mod) {
        if (r + 1 < rowCount()) go(r + 1, c);
        else {
          // Past the last row: a new one.
          go(r + 1, c);
          const end = from() + state.widget.src.length;
          view.dispatch({ changes: { from: end, insert: emptyRow(cols()) }, userEvent: "input.table" });
        }
      } else if (e.key === "ArrowUp") {
        if (r > 0) go(r - 1, c);
        else leave("up");
      } else if (e.key === "ArrowDown") {
        if (r + 1 < rowCount()) go(r + 1, c);
        else leave("down");
      } else if (e.key === "ArrowLeft" && caretOffset(cell) === 0 && c > 0) go(r, c - 1);
      else if (e.key === "ArrowRight" && caretOffset(cell) === text.length && c + 1 < cols()) {
        go(r, c + 1, false);
      } else if (e.key === "Escape") {
        view.dispatch({ selection: { anchor: from() } });
        view.focus();
      } else if (mod && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
        const base = from();
        (e.shiftKey || e.key.toLowerCase() === "y" ? redo : undo)(view);
        // The table may have been rebuilt (a row came or went): stay in the nearest cell.
        requestAnimationFrame(() => {
          const w = wraps.get(tableDomAt(view, base) ?? wrap)?.widget ?? state.widget;
          focusCell(view, base, Math.min(r, w.layout.rows.length), Math.min(c, w.layout.head.cells.length - 1));
        });
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    wrap.addEventListener("mousedown", (e) => {
      const btn = e.target instanceof HTMLElement ? e.target.closest(".cm-md-table-src-btn") : null;
      if (!btn) return;
      e.preventDefault();
      view.dispatch({ effects: toggleTableSource.of(from()), selection: { anchor: from() } });
      view.focus();
    });
    return wrap;
  }

  /** Same shape: the cells' text is refreshed in place, so the one being typed in keeps focus. */
  updateDOM(dom: HTMLElement): boolean {
    const state = wraps.get(dom);
    if (!state) return false;
    const next = this.layout;
    const prev = state.widget.layout;
    const shape = (l: TableLayout) => [l.head.cells.length, ...l.rows.map((r) => r.cells.length)].join();
    if (shape(next) !== shape(prev) || next.align.join() !== prev.align.join()) return false;
    state.widget = this;
    [next.head, ...next.rows].forEach((row, r) =>
      row.cells.forEach((cell, c) => {
        const el = dom.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`);
        if (el && el !== state.typing && el.textContent !== cell.text) el.textContent = cell.text;
      }),
    );
    return true;
  }

  private build(wrap: HTMLElement) {
    const t = this.layout;
    const cols = t.head.cells.length;
    const table = document.createElement("table");
    table.className = "cm-md-table";
    const row = (r: number, values: CellRange[], tag: "th" | "td") => {
      const tr = document.createElement("tr");
      for (let c = 0; c < cols; c++) {
        const td = document.createElement(tag);
        if (t.align[c]) td.style.textAlign = t.align[c]!;
        const cell = document.createElement("span");
        cell.className = "cm-md-cell";
        cell.contentEditable = "plaintext-only";
        cell.spellcheck = false;
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);
        cell.textContent = values[c]?.text ?? "";
        td.append(cell);
        tr.append(td);
      }
      return tr;
    };
    const thead = document.createElement("thead");
    thead.append(row(0, t.head.cells, "th"));
    const tbody = document.createElement("tbody");
    t.rows.forEach((r, i) => tbody.append(row(i + 1, r.cells, "td")));
    table.append(thead, tbody);
    const btn = document.createElement("button");
    btn.className = "cm-md-table-src-btn";
    btn.tabIndex = -1;
    btn.textContent = "‹›";
    btn.title = "source";
    wrap.replaceChildren(table, btn);
  }

  ignoreEvent() {
    return true;
  }
}

/** Stepping onto a rendered table from the line above or below puts the caret in its first or last row. */
export const focusEnteredTable = ViewPlugin.define((view) => ({
  update(u: ViewUpdate) {
    for (const tr of u.transactions) {
      const dir = tr.annotation(enteredBlock);
      if (!dir) continue;
      const head = u.state.selection.main.head;
      requestAnimationFrame(() => {
        for (const el of view.contentDOM.querySelectorAll<HTMLElement>(".cm-md-table-wrap")) {
          const from = view.posAtDOM(el);
          const w = wraps.get(el)?.widget;
          if (!w || head < from || head > from + w.src.length) continue;
          focusCell(view, from, dir === "down" ? 0 : w.layout.rows.length, 0);
        }
      });
    }
  },
}));

export const isTableSource = (state: EditorState, from: number) =>
  state.field(tableSource, false)?.includes(from) ?? false;
