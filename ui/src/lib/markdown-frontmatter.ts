// Frontmatter in rich markdown: the YAML block at the top of a note shows as
// properties, one row per key with its value as a field (lists as chips,
// booleans as a checkbox). Typing into a field rewrites just that value in the
// source, like a table cell, so undo and saving work as for any other edit.
// The `‹›` button shows the YAML itself; values that are not plain scalars or
// lists (nested maps, `|` blocks) show read-only.
import { redo, undo } from "@codemirror/commands";
import type { EditorState } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { t } from "./i18n";
import { isTableSource, narrow, toggleTableSource } from "./markdown-table";

export type Quote = '"' | "'" | "";

export interface FmValue {
  /** Document offsets of the value as written, quotes included. */
  from: number;
  to: number;
  /** As shown: unquoted and unescaped. */
  text: string;
  quote: Quote;
  /** Written before a value that was empty (the space after `key:`). */
  lead: string;
}

export interface FmField {
  key: string;
  kind: "text" | "bool" | "list" | "raw";
  /** A `[a, b]` list rather than `- a` lines. */
  flow: boolean;
  values: FmValue[];
}

export interface Frontmatter {
  /** End of the closing `---` line. */
  to: number;
  fields: FmField[];
}

const KEY = /^([^\s#:'"[\]{},-][^:#]*?)[ \t]*:(?=\s|$)(.*)$/;
const FENCE = /^(---|\.\.\.)[ \t]*$/;

/** The scalar in `line[from, to)`: quoted, or plain up to a ` #` comment. Offsets are shifted by `base`. */
function scalarIn(line: string, from: number, to: number, base: number, flow: boolean): FmValue {
  let i = from;
  while (i < to && /\s/.test(line[i])) i++;
  const q = line[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    let text = "";
    for (; j < to; j++) {
      if (q === '"' && line[j] === "\\" && j + 1 < to) {
        const c = line[++j];
        text += c === "n" ? "\n" : c === "t" ? "\t" : c;
      } else if (line[j] === q) {
        if (q === "'" && line[j + 1] === "'") (text += "'"), j++;
        else break;
      } else text += line[j];
    }
    return { from: base + i, to: base + Math.min(j + 1, to), text, quote: q, lead: "" };
  }
  let end = to;
  if (!flow) {
    const hash = line.slice(i, to).search(/\s#/);
    if (hash >= 0) end = i + hash;
  }
  while (end > i && /\s/.test(line[end - 1])) end--;
  if (end === i) {
    // Empty: a value typed here goes at the end, after a space.
    const at = flow ? i : to;
    return { from: base + at, to: base + at, text: "", quote: "", lead: flow || /\s$/.test(line.slice(0, at)) ? "" : " " };
  }
  return { from: base + i, to: base + end, text: line.slice(i, end), quote: "", lead: "" };
}

/** Items of a `[a, "b, c"]` list, split on commas outside quotes. */
function flowItems(line: string, open: number, close: number, base: number): FmValue[] {
  const out: FmValue[] = [];
  let start = open + 1;
  let q = "";
  for (let i = open + 1; i <= close; i++) {
    const c = line[i];
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === "," || i === close) {
      if (line.slice(start, i).trim() || c === ",") out.push(scalarIn(line, start, i, base, true));
      start = i + 1;
    }
  }
  return out;
}

/** The `---` block at the very top of `src`, if it is one. */
export function parseFrontmatter(src: string): Frontmatter | null {
  const raw = src.split("\n");
  const lines = raw.map((l) => l.replace(/\r$/, ""));
  if (lines.length < 2 || !/^---[ \t]*$/.test(lines[0])) return null;
  const close = lines.findIndex((l, i) => i > 0 && FENCE.test(l));
  if (close < 0) return null;
  const starts: number[] = [];
  for (let i = 0, at = 0; i <= close; at += raw[i].length + 1, i++) starts.push(at);
  const fields: FmField[] = [];
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    const m = KEY.exec(line);
    if (!m) continue;
    // Lines below that belong to this key: indented ones and `- item`s.
    let end = i;
    while (end + 1 < close && /^(\s+\S|-(\s|$))/.test(lines[end + 1])) end++;
    const children = lines.slice(i + 1, end + 1);
    const rest = m[2];
    const restFrom = line.length - rest.length;
    const field: FmField = { key: m[1], kind: "text", flow: false, values: [] };
    const trimmed = rest.trim();
    if (!trimmed && children.length && children.every((l) => /^\s*-(\s|$)/.test(l))) {
      field.kind = "list";
      field.values = children.map((l, k) => scalarIn(l, l.indexOf("-") + 1, l.length, starts[i + 1 + k], false));
    } else if (children.length || /^[|>{]/.test(trimmed)) {
      field.kind = "raw";
      const from = starts[i] + restFrom;
      const to = starts[end] + lines[end].length;
      const text = [trimmed, ...children.map((l) => l.trim())].filter(Boolean).join("\n");
      field.values = [{ from, to, text, quote: "", lead: "" }];
    } else if (trimmed.startsWith("[")) {
      const open = line.indexOf("[", restFrom);
      const shut = line.lastIndexOf("]");
      if (shut < open) {
        field.kind = "raw";
        field.values = [{ from: starts[i] + open, to: starts[i] + line.length, text: trimmed, quote: "", lead: "" }];
      } else {
        field.kind = "list";
        field.flow = true;
        field.values = flowItems(line, open, shut, starts[i]);
      }
    } else {
      const v = scalarIn(line, restFrom, line.length, starts[i], false);
      if (!v.quote && /^(true|false)$/i.test(v.text)) field.kind = "bool";
      field.values = [v];
    }
    fields.push(field);
    i = end;
  }
  return { to: starts[close] + lines[close].length, fields };
}

/** The frontmatter of a document; only its first lines are read. */
export function frontmatterOf(state: EditorState): Frontmatter | null {
  const doc = state.doc;
  if (doc.lines < 2 || !/^---[ \t]*$/.test(doc.line(1).text)) return null;
  return parseFrontmatter(doc.sliceString(0, doc.line(Math.min(doc.lines, 2000)).to));
}

/**
 * What typing `text` into a value writes. Plain text stays plain unless YAML
 * would read it as something else (a key, a comment, a list, a boolean), which
 * also keeps a text field from turning into a checkbox while typing.
 */
export function writeValue(text: string, v: FmValue, flow: boolean): string {
  text = text.replace(/\r?\n/g, " ");
  const risky =
    /^[\s\-?:,[\]{}#&*!|>'"%@`]|:\s|:$|\s#|\s$/.test(text) ||
    (flow && /[,[\]{}]/.test(text)) ||
    /^(true|false|yes|no|on|off|null|~)$/i.test(text);
  const q = v.quote || (risky ? '"' : "");
  if (!text && !q) return "";
  const body =
    q === '"' ? `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : q === "'" ? `'${text.replace(/'/g, "''")}'`
    : text;
  return (v.from === v.to ? v.lead : "") + body;
}

// ── the widget ──────────────────────────────────────────────────────────────

/** Where the editor caret goes when it may not sit inside the frontmatter: the line below it. */
function below(state: EditorState, fm: Frontmatter): number {
  return Math.min(fm.to + 1, state.doc.length);
}

function propsDom(view: EditorView): HTMLElement | null {
  return view.contentDOM.querySelector<HTMLElement>(".cm-md-props");
}

/** The fields in reading order: text values, chips and checkboxes. */
function stops(root: HTMLElement | null): HTMLElement[] {
  return root ? [...root.querySelectorAll<HTMLElement>("[data-f]")] : [];
}

function focusStop(el: HTMLElement | undefined, atEnd = true) {
  if (!el) return false;
  el.focus();
  if (el instanceof HTMLInputElement) return true;
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(!atEnd);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return true;
}

interface WrapState {
  widget: FrontmatterWidget;
  /** The field whose own input caused the update in flight; its DOM is already right. */
  typing: HTMLElement | null;
}
const wraps = new WeakMap<HTMLElement, WrapState>();

const shapeOf = (fm: Frontmatter) => fm.fields.map((f) => `${f.key}:${f.kind}:${f.values.length}`).join("\n");

export class FrontmatterWidget extends WidgetType {
  /** `src` is the document from 0 to the end of the closing `---`. */
  constructor(readonly src: string) {
    super();
  }

  eq(o: FrontmatterWidget) {
    return o.src === this.src;
  }

  get fm(): Frontmatter {
    return parseFrontmatter(this.src) ?? { to: this.src.length, fields: [] };
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-props";
    const state: WrapState = { widget: this, typing: null };
    wraps.set(wrap, state);
    this.build(wrap);

    const hit = (el: EventTarget | null) => {
      const node = el instanceof HTMLElement ? el.closest<HTMLElement>("[data-f]") : null;
      if (!node) return null;
      const field = state.widget.fm.fields[Number(node.dataset.f)];
      const value = field?.values[Number(node.dataset.i)];
      return field && value ? { node, field, value } : null;
    };
    const write = (value: FmValue, insert: string) => {
      const change = narrow(state.widget.src, { from: value.from, to: value.to, insert });
      if (change.from === change.to && !change.insert) return;
      view.dispatch({ changes: change, userEvent: "input.type" });
    };
    const leave = () => {
      const fm = state.widget.fm;
      if (fm.to >= view.state.doc.length) {
        view.dispatch({ changes: { from: fm.to, insert: "\n" }, selection: { anchor: fm.to + 1 } });
      } else view.dispatch({ selection: { anchor: below(view.state, fm) }, scrollIntoView: true });
      view.focus();
    };
    const step = (from: HTMLElement, by: number) => {
      const all = stops(wrap);
      const next = all[all.indexOf(from) + by];
      if (next) focusStop(next);
      else if (by > 0) leave();
    };

    wrap.addEventListener("input", (e) => {
      const h = hit(e.target);
      if (!h || h.node instanceof HTMLInputElement) return;
      state.typing = h.node;
      write(h.value, writeValue(h.node.textContent ?? "", h.value, h.field.flow));
      state.typing = null;
    });

    wrap.addEventListener("change", (e) => {
      const h = hit(e.target);
      if (!h || !(h.node instanceof HTMLInputElement)) return;
      write(h.value, h.node.checked ? "true" : "false");
    });

    wrap.addEventListener("keydown", (e) => {
      const h = hit(e.target);
      if (!h) return;
      const mod = e.metaKey || e.ctrlKey;
      let handled = true;
      if ((e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && !mod) || e.key === "ArrowDown") step(h.node, 1);
      else if ((e.key === "Tab" && e.shiftKey) || e.key === "ArrowUp") step(h.node, -1);
      else if (e.key === "Escape") leave();
      else if (mod && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
        const at = stops(wrap).indexOf(h.node);
        (e.shiftKey || e.key.toLowerCase() === "y" ? redo : undo)(view);
        // The rows may have been rebuilt: stay on the same field, or the nearest one.
        requestAnimationFrame(() => {
          const all = stops(propsDom(view));
          focusStop(all[Math.min(at, all.length - 1)]);
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
      view.dispatch({ effects: toggleTableSource.of(0), selection: { anchor: 0 } });
      view.focus();
    });
    return wrap;
  }

  /** Same keys and kinds: values are refreshed in place, so the field being typed in keeps focus. */
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const state = wraps.get(dom);
    if (!state) return false;
    const next = this.fm;
    if (shapeOf(next) !== shapeOf(state.widget.fm)) {
      // Rebuilt: a focused field comes back focused.
      const at = stops(dom).indexOf(document.activeElement as HTMLElement);
      state.widget = this;
      this.build(dom);
      if (at >= 0) requestAnimationFrame(() => focusStop(stops(propsDom(view))[at]));
      return true;
    }
    state.widget = this;
    for (const el of stops(dom)) {
      const v = next.fields[Number(el.dataset.f)].values[Number(el.dataset.i)];
      if (el instanceof HTMLInputElement) el.checked = v.text.toLowerCase() === "true";
      else if (el !== state.typing && el.textContent !== v.text) el.textContent = v.text;
    }
    return true;
  }

  private build(wrap: HTMLElement) {
    const head = document.createElement("div");
    head.className = "cm-md-props-head";
    const title = document.createElement("span");
    title.textContent = t("md.properties");
    const btn = document.createElement("button");
    btn.className = "cm-md-table-src-btn";
    btn.tabIndex = -1;
    btn.textContent = "‹›";
    btn.title = t("md.source");
    head.append(title, btn);

    const rows = this.fm.fields.map((field, f) => {
      const row = document.createElement("div");
      row.className = "cm-md-prop";
      const key = document.createElement("span");
      key.className = "cm-md-prop-key";
      key.textContent = field.key;
      key.title = field.key;
      const val = document.createElement("span");
      val.className = `cm-md-prop-value ${field.kind}`;
      const editable = (v: FmValue, i: number, cls: string) => {
        const el = document.createElement("span");
        el.className = cls;
        el.contentEditable = "plaintext-only";
        el.spellcheck = false;
        el.dataset.f = String(f);
        el.dataset.i = String(i);
        el.dataset.empty = t("md.empty");
        el.textContent = v.text;
        return el;
      };
      if (field.kind === "bool") {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = field.values[0].text.toLowerCase() === "true";
        box.dataset.f = String(f);
        box.dataset.i = "0";
        val.append(box);
      } else if (field.kind === "list") {
        field.values.forEach((v, i) => val.append(editable(v, i, "cm-md-chip")));
        if (!field.values.length) val.dataset.empty = t("md.empty");
      } else if (field.kind === "raw") {
        val.textContent = field.values[0].text;
      } else val.append(editable(field.values[0], 0, "cm-md-prop-field"));
      row.append(key, val);
      return row;
    });
    wrap.replaceChildren(head, ...rows);
  }

  ignoreEvent() {
    return true;
  }
}

/**
 * The caret never rests inside rendered frontmatter (typing there would land
 * in the YAML's markup): it moves to the line below. Coming up from that line
 * puts it in the last field instead.
 */
export const frontmatterCursor = ViewPlugin.define((view) => {
  let pending = false;
  const inside = (state: EditorState) => {
    const sel = state.selection;
    if (sel.ranges.length !== 1 || !sel.main.empty || isTableSource(state, 0)) return null;
    const fm = frontmatterOf(state);
    if (!fm) return null;
    const head = sel.main.head;
    return head < fm.to || (head === fm.to && fm.to < state.doc.length) ? fm : null;
  };
  const check = (fromBelow: boolean) => {
    if (pending || !inside(view.state)) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const fm = inside(view.state);
      // A field being typed in owns the caret. WebKit may leave focus on the
      // editor's content while the DOM selection sits in the field: check both.
      const props = propsDom(view);
      const anchor = window.getSelection()?.anchorNode ?? null;
      if (!fm || props?.contains(document.activeElement) || (anchor && props?.contains(anchor))) return;
      view.dispatch({ selection: { anchor: below(view.state, fm) } });
      if (fromBelow) {
        const all = stops(propsDom(view));
        focusStop(all[all.length - 1]);
      }
    });
  };
  check(false);
  return {
    update(u: ViewUpdate) {
      if (!u.selectionSet && !u.docChanged && !u.transactions.some((tr) => tr.effects.length)) return;
      const before = frontmatterOf(u.startState);
      check(!!before && u.startState.selection.main.head > before.to);
    },
  };
});
