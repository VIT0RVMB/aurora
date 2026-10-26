// Rich markdown: the source stays editable, but markup is hidden and blocks
// render in place (Obsidian's live preview). Lines the selection touches show
// their markup as typed, so editing (and vim) always works on the real text.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorSelection, EditorState, type Extension, Facet, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import {
  enteredBlock,
  focusEnteredTable,
  isTableSource,
  TableWidget,
  tableSource,
  toggleTableSource,
} from "./markdown-table";

/** Markdown with GFM (tables, tasks, strikethrough) and highlighted fenced code. */
export const markdownSupport = () => markdown({ base: markdownLanguage, codeLanguages: languages });

export interface RawLink {
  kind: "href" | "wiki";
  target: string;
}

export interface RichOptions {
  /** Follows a link (click on a rendered one, ⌘-click, ⌘Enter, vim `gf`). */
  onLink: (link: RawLink) => void;
  /** Turns an image `src` into something `<img>` can show, or null. */
  loadImage: (src: string) => Promise<string | null>;
}

const optionsFacet = Facet.define<RichOptions, RichOptions | null>({ combine: (v) => v[0] ?? null });

const WIKI = /\[\[([^\]\n]+)\]\]/g;
const inWiki = (around: string) => around.startsWith("[[") && around.endsWith("]]");
const CODE_NODES = new Set(["CodeText", "InlineCode", "FencedCode", "CodeBlock", "CodeMark", "CodeInfo"]);

// ── widgets ─────────────────────────────────────────────────────────────────

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-md-bullet";
    s.textContent = "•";
    return s;
  }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: TaskWidget) {
    return o.checked === this.checked;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-md-task";
    s.textContent = this.checked ? "[x]" : "[ ]";
    return s;
  }
  ignoreEvent() {
    return false;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-md-hr";
    return s;
  }
}

class LangWidget extends WidgetType {
  constructor(readonly info: string) {
    super();
  }
  eq(o: LangWidget) {
    return o.info === this.info;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-md-lang";
    s.textContent = this.info;
    return s;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-image";
    const fallback = () => (wrap.textContent = `▣ ${this.alt || this.src}`);
    fallback();
    const opts = view.state.facet(optionsFacet);
    void opts?.loadImage(this.src).then((url) => {
      if (!url) return;
      const img = document.createElement("img");
      img.src = url;
      img.alt = this.alt;
      img.onerror = fallback;
      wrap.replaceChildren(img);
      view.requestMeasure();
    });
    return wrap;
  }
}

// Mermaid is big: it loads the first time a diagram shows up.
let mermaidLib: Promise<typeof import("mermaid").default> | null = null;
let mermaidTheme = "";
let mermaidSeq = 0;
const diagrams = new Map<string, Promise<string>>();

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

async function renderMermaid(src: string): Promise<string> {
  mermaidLib ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidLib;
  const theme = [cssVar("--bg-raised"), cssVar("--fg"), cssVar("--accent"), cssVar("--font-mono")].join("|");
  if (theme !== mermaidTheme) {
    mermaidTheme = theme;
    diagrams.clear();
    mermaid.initialize({
      startOnLoad: false,
      // Agent-written diagrams: no HTML labels, no click handlers, no scripts.
      securityLevel: "strict",
      theme: "base",
      fontFamily: cssVar("--font-mono"),
      themeVariables: {
        background: cssVar("--bg"),
        primaryColor: cssVar("--bg-raised"),
        primaryTextColor: cssVar("--fg"),
        primaryBorderColor: cssVar("--accent"),
        secondaryColor: cssVar("--bg-panel"),
        tertiaryColor: cssVar("--bg-panel"),
        lineColor: cssVar("--fg-dim"),
        textColor: cssVar("--fg"),
        fontFamily: cssVar("--font-mono"),
      },
    });
  }
  let svg = diagrams.get(src);
  if (!svg) {
    const id = `aurora-mermaid-${++mermaidSeq}`;
    svg = mermaid.render(id, src).then(
      (r) => r.svg,
      (e: unknown) => {
        document.getElementById(`d${id}`)?.remove();
        diagrams.delete(src);
        throw e;
      },
    );
    diagrams.set(src, svg);
  }
  return svg;
}

class MermaidWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }
  eq(o: MermaidWidget) {
    return o.src === this.src;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-md-mermaid";
    box.textContent = "mermaid…";
    renderMermaid(this.src).then(
      (svg) => {
        box.innerHTML = svg;
        view.requestMeasure();
      },
      (e: unknown) => {
        box.classList.add("error");
        box.textContent = `mermaid: ${e instanceof Error ? e.message : String(e)}`;
      },
    );
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

/** At the end of a table shown as source: back to the rendered table. */
class SourceBackWidget extends WidgetType {
  constructor(readonly from: number) {
    super();
  }
  eq(o: SourceBackWidget) {
    return o.from === this.from;
  }
  toDOM(view: EditorView) {
    const b = document.createElement("button");
    b.className = "cm-md-table-src-btn inline";
    b.tabIndex = -1;
    b.textContent = "▦";
    b.title = "table";
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ effects: toggleTableSource.of(this.from) });
    });
    return b;
  }
  ignoreEvent() {
    return true;
  }
}

// ── decorations ─────────────────────────────────────────────────────────────

const hidden = Decoration.replace({});

/** Line numbers the selection touches. */
function activeLines(state: EditorState): Set<number> {
  const out = new Set<number>();
  for (const r of state.selection.ranges) {
    const last = state.doc.lineAt(r.to).number;
    for (let n = state.doc.lineAt(r.from).number; n <= last; n++) out.add(n);
  }
  return out;
}

export function richDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const lines = activeLines(state);
  const lineOf = (pos: number) => doc.lineAt(pos).number;
  const shown = (from: number, to = from) => {
    for (let n = lineOf(from), last = lineOf(to); n <= last; n++) if (lines.has(n)) return true;
    return false;
  };
  const out: Range<Decoration>[] = [];
  const hide = (from: number, to: number) => to > from && out.push(hidden.range(from, to));
  const lineClass = (from: number, to: number, cls: string) => {
    for (let n = lineOf(from), last = lineOf(to); n <= last; n++) {
      out.push(Decoration.line({ class: cls }).range(doc.line(n).from));
    }
  };
  const text = (n: SyntaxNodeRef) => doc.sliceString(n.from, n.to);
  const tree = syntaxTree(state);

  tree.iterate({
    enter: (n) => {
      const name = n.name;
      const heading = /^(ATX|Setext)Heading(\d)$/.exec(name);
      if (heading) {
        lineClass(n.from, n.from, `cm-md-h cm-md-h${heading[2]}`);
        return;
      }
      switch (name) {
        case "HeaderMark": {
          if (shown(n.from)) return;
          const parent = n.node.parent!;
          if (parent.name.startsWith("Setext")) return void hide(n.from, n.to);
          const opening = n.from === parent.from;
          if (opening) hide(n.from, n.to + (doc.sliceString(n.to, n.to + 1) === " " ? 1 : 0));
          else hide(n.from - (doc.sliceString(n.from - 1, n.from) === " " ? 1 : 0), n.to);
          return;
        }
        case "EmphasisMark":
        case "StrikethroughMark":
          if (!shown(n.from)) hide(n.from, n.to);
          return;
        case "InlineCode":
          out.push(Decoration.mark({ class: "cm-md-code" }).range(n.from, n.to));
          if (!shown(n.from, n.to)) for (const m of n.node.getChildren("CodeMark")) hide(m.from, m.to);
          return false;
        case "Link":
        case "Autolink": {
          // `[[x]]` reads as a link `[x]` in brackets: the wiki pass owns it.
          if (inWiki(doc.sliceString(n.from - 1, n.to + 1))) return false;
          const url = n.node.getChild("URL");
          const marks = n.node.getChildren("LinkMark");
          const attrs: Record<string, string> = url ? { "data-href": text(url) } : {};
          if (shown(n.from, n.to) || marks.length < 2) {
            out.push(Decoration.mark({ class: "cm-md-link", attributes: attrs }).range(n.from, n.to));
            return;
          }
          if (name === "Autolink") {
            hide(marks[0].from, marks[0].to);
            out.push(Decoration.mark({ class: "cm-md-link rendered", attributes: attrs }).range(marks[0].to, marks[1].from));
            hide(marks[1].from, marks[1].to);
            return false;
          }
          hide(n.from, marks[0].to);
          if (marks[1].from > marks[0].to) {
            out.push(Decoration.mark({ class: "cm-md-link rendered", attributes: attrs }).range(marks[0].to, marks[1].from));
          }
          hide(marks[1].from, n.to);
          return;
        }
        case "Image": {
          if (shown(n.from, n.to)) return;
          const url = n.node.getChild("URL");
          const marks = n.node.getChildren("LinkMark");
          if (!url || marks.length < 2) return;
          const alt = doc.sliceString(marks[0].to, marks[1].from);
          out.push(Decoration.replace({ widget: new ImageWidget(text(url), alt) }).range(n.from, n.to));
          return false;
        }
        case "ListMark": {
          const task = n.node.nextSibling?.name === "Task" ? n.node.nextSibling : null;
          if (task) {
            const marker = task.getChild("TaskMarker");
            if (!marker) return;
            const checked = /x/i.test(doc.sliceString(marker.from, marker.to));
            if (checked) lineClass(n.from, n.from, "cm-md-done");
            if (!shown(n.from)) {
              out.push(Decoration.replace({ widget: new TaskWidget(checked) }).range(n.from, marker.to));
            }
            return;
          }
          if (n.node.parent?.parent?.name === "BulletList" && !shown(n.from)) {
            out.push(Decoration.replace({ widget: new BulletWidget() }).range(n.from, n.to));
          }
          return;
        }
        case "Blockquote":
          lineClass(n.from, n.to, "cm-md-quote");
          return;
        case "QuoteMark":
          if (!shown(n.from)) hide(n.from, n.to + (doc.sliceString(n.to, n.to + 1) === " " ? 1 : 0));
          return;
        case "HorizontalRule":
          if (!shown(n.from)) out.push(Decoration.replace({ widget: new RuleWidget() }).range(n.from, n.to));
          return;
        case "FencedCode": {
          const info = n.node.getChild("CodeInfo");
          const lang = info ? text(info).trim() : "";
          const open = shown(n.from, n.to);
          if (lang === "mermaid" && !open) {
            const code = n.node.getChild("CodeText");
            const src = code ? text(code) : "";
            out.push(Decoration.replace({ widget: new MermaidWidget(src), block: true }).range(n.from, n.to));
            return false;
          }
          lineClass(n.from, n.to, "cm-md-codeblock");
          if (!open) {
            const first = doc.lineAt(n.from);
            const last = doc.lineAt(n.to);
            out.push(Decoration.replace({ widget: new LangWidget(lang) }).range(first.from, first.to));
            if (last.number > first.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text)) hide(last.from, last.to);
          }
          return false;
        }
        case "Table":
          // Tables stay rendered under the cursor (their cells are editable);
          // the `‹›` button switches one to its source.
          if (!isTableSource(state, n.from)) {
            out.push(Decoration.replace({ widget: new TableWidget(text(n)), block: true }).range(n.from, n.to));
          } else {
            lineClass(n.from, n.to, "cm-md-table-src");
            const first = doc.lineAt(n.from);
            out.push(Decoration.widget({ widget: new SourceBackWidget(n.from), side: 1 }).range(first.to));
          }
          return false;
      }
    },
  });

  // `[[wiki]]` links are not markdown: found by text, outside code.
  const all = doc.toString();
  for (const m of all.matchAll(WIKI)) {
    const from = m.index;
    const to = from + m[0].length;
    if (CODE_NODES.has(tree.resolveInner(from + 2, 1).name)) continue;
    const inner = m[1];
    const attrs = { "data-wiki": inner };
    if (shown(from, to)) {
      out.push(Decoration.mark({ class: "cm-md-link", attributes: attrs }).range(from, to));
      continue;
    }
    // `[[target|alias]]` shows the alias.
    const bar = inner.indexOf("|");
    const labelFrom = bar < 0 ? from + 2 : from + 2 + bar + 1;
    hide(from, labelFrom);
    out.push(Decoration.mark({ class: "cm-md-link rendered", attributes: attrs }).range(labelFrom, to - 2));
    hide(to - 2, to);
  }

  return Decoration.set(out, true);
}

/** Recomputed when the text, the parse or the set of touched lines changes. */
const richField = StateField.define<{ deco: DecorationSet; lines: string }>({
  create: (state) => ({ deco: richDecorations(state), lines: [...activeLines(state)].join() }),
  update(value, tr) {
    const lines = [...activeLines(tr.state)].join();
    const reparsed = syntaxTree(tr.state) !== syntaxTree(tr.startState);
    const toggled = tr.effects.some((e) => e.is(toggleTableSource));
    if (!tr.docChanged && !reparsed && !toggled && lines === value.lines) return value;
    return { deco: richDecorations(tr.state), lines };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/**
 * A rendered table or diagram is one visual line, so a vertical step would
 * hop over it. A step from the line above it to the line below it (or back)
 * lands on the block instead, which shows its source for editing.
 */
const enterBlocks = EditorState.transactionFilter.of((tr) => {
  const sel = tr.selection;
  if (tr.docChanged || !sel || sel.ranges.length !== 1 || !sel.main.empty) return tr;
  const before = tr.startState.selection.main.head;
  const after = sel.main.head;
  const deco = tr.startState.field(richField, false)?.deco;
  if (before === after || !deco) return tr;
  const doc = tr.startState.doc;
  const down = after > before;
  const [oldLine, newLine] = [doc.lineAt(before).number, doc.lineAt(after).number];
  let target = -1;
  deco.between(Math.min(before, after), Math.max(before, after), (from, to, d) => {
    if (!(d.spec as { block?: boolean }).block) return;
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    const hop = down ? oldLine === first - 1 && newLine === last + 1 : oldLine === last + 1 && newLine === first - 1;
    if (hop) {
      target = down ? from : doc.line(last).from;
      return false;
    }
  });
  return target < 0
    ? tr
    : [tr, { selection: EditorSelection.cursor(target), annotations: enteredBlock.of(down ? "down" : "up"), sequential: true }];
});

// ── links and tasks ─────────────────────────────────────────────────────────

/** The link at `pos`, if any: markdown links and autolinks first, then `[[wiki]]`. */
export function linkAt(state: EditorState, pos: number): RawLink | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "Link" || n.name === "Autolink" || n.name === "Image") {
      const url = n.getChild("URL");
      if (url) return { kind: "href", target: state.sliceDoc(url.from, url.to) };
      break;
    }
  }
  const line = state.doc.lineAt(pos);
  for (const m of line.text.matchAll(WIKI)) {
    const from = line.from + m.index;
    if (pos >= from && pos <= from + m[0].length) return { kind: "wiki", target: m[1] };
  }
  return null;
}

/** Flips the `[ ]` / `[x]` of the task on the line at `pos`. */
export function toggleTask(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/.exec(line.text);
  if (!m) return false;
  const at = line.from + m[1].length;
  view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === " " ? "x" : " " } });
  return true;
}

export function followLinkAt(view: EditorView, pos = view.state.selection.main.head): boolean {
  const link = linkAt(view.state, pos);
  const opts = view.state.facet(optionsFacet);
  if (!link || !opts) return false;
  opts.onLink(link);
  return true;
}

const handlers = EditorView.domEventHandlers({
  mousedown(e, view) {
    const el = e.target instanceof Element ? e.target : null;
    if (!el || e.button !== 0) return false;
    const task = el.closest(".cm-md-task");
    if (task) {
      e.preventDefault();
      return toggleTask(view, view.posAtDOM(task));
    }
    const link = el.closest<HTMLElement>("[data-href], [data-wiki]");
    // A rendered link opens on click; one showing its markup needs ⌘ / Ctrl.
    if (link && (e.metaKey || e.ctrlKey || link.classList.contains("rendered"))) {
      const opts = view.state.facet(optionsFacet);
      if (!opts) return false;
      e.preventDefault();
      const href = link.dataset.href;
      opts.onLink(href != null ? { kind: "href", target: href } : { kind: "wiki", target: link.dataset.wiki! });
      return true;
    }
    return false;
  },
});

const MONO = "var(--font-mono)";

const proseTheme = EditorView.theme({
  "&.cm-md-prose .cm-content": {
    fontFamily: "var(--font-ui)",
    fontSize: "calc(var(--font-size) + 2px)",
    lineHeight: "1.65",
    maxWidth: "760px",
    padding: "var(--sp-4) var(--sp-5) 30vh",
  },
  "&.cm-md-prose .cm-gutters": { display: "none" },
  "&.cm-md-prose .cm-activeLine": { backgroundColor: "transparent" },
  "&.cm-md-prose .cm-md-code, &.cm-md-prose .cm-md-codeblock, &.cm-md-prose .cm-md-table-src": {
    fontFamily: MONO,
    fontSize: "var(--font-size)",
  },
  "&.cm-md-prose .cm-md-h1, &.cm-md-prose .cm-md-h2": { lineHeight: "1.4" },
});

const richTheme = EditorView.baseTheme({
  ".cm-md-h": { fontWeight: "bold", color: "var(--syn-heading)" },
  ".cm-md-h1": { fontSize: "1.75em", lineHeight: "calc(var(--cell-h) * 2)", letterSpacing: "-0.015em" },
  ".cm-md-h2": { fontSize: "1.4em", lineHeight: "calc(var(--cell-h) * 1.5)", letterSpacing: "-0.01em" },
  ".cm-md-h3": { fontSize: "1.15em" },
  ".cm-md-code": { backgroundColor: "var(--bg-active)", color: "var(--syn-string)", borderRadius: "3px", padding: "1px 3px" },
  ".cm-md-link": { color: "var(--syn-link)", textDecoration: "underline", cursor: "pointer" },
  ".cm-md-bullet": { color: "var(--accent)" },
  ".cm-md-task": { color: "var(--accent)", cursor: "pointer" },
  ".cm-md-done": { color: "var(--fg-dim)", textDecoration: "line-through" },
  ".cm-md-quote": { borderLeft: "3px solid var(--line-strong)", color: "var(--fg-dim)" },
  ".cm-md-hr": {
    display: "inline-block",
    width: "100%",
    verticalAlign: "middle",
    borderTop: "1px solid var(--line-strong)",
  },
  ".cm-md-codeblock": { backgroundColor: "var(--bg-panel)", paddingLeft: "var(--sp-3) !important" },
  ".cm-md-lang": { color: "var(--fg-faint)" },
  ".cm-md-table-src": { color: "var(--fg-dim)" },
  ".cm-md-table-wrap": { position: "relative", display: "flex", alignItems: "flex-start", gap: "var(--cell-w)" },
  ".cm-md-table": { borderCollapse: "collapse", margin: "0 var(--cell-w)" },
  ".cm-md-cell": { display: "inline-block", minWidth: "calc(var(--cell-w) * 2)", outline: "none", whiteSpace: "pre-wrap" },
  ".cm-md-table td:focus-within, .cm-md-table th:focus-within": { backgroundColor: "var(--bg-select-dim)", outline: "1px solid var(--accent)" },
  ".cm-md-table-src-btn": { color: "var(--fg-faint)", cursor: "pointer", padding: "0", background: "none", border: "none", font: "inherit" },
  ".cm-md-table-src-btn:hover": { color: "var(--accent)" },
  ".cm-md-table-src-btn.inline": { marginLeft: "var(--cell-w)" },
  ".cm-md-table th, .cm-md-table td": { border: "1px solid var(--line)", padding: "var(--sp-1) var(--sp-3)" },
  ".cm-md-table th": { color: "var(--syn-heading)", textAlign: "left", backgroundColor: "var(--bg-panel)", fontWeight: "600" },
  ".cm-md-mermaid": { padding: "var(--cell-h) var(--cell-w)", color: "var(--fg-dim)" },
  ".cm-md-mermaid svg": { maxWidth: "100%", height: "auto" },
  ".cm-md-mermaid.error": { color: "var(--danger)", whiteSpace: "pre-wrap" },
  ".cm-md-image img": { maxWidth: "100%", maxHeight: "60vh", display: "block" },
  ".cm-md-image": { color: "var(--fg-dim)" },
});

/** Links work in source mode too (⌘-click, ⌘Enter, `gf`); rich mode adds the rendering. */
export function markdownLinks(o: RichOptions): Extension {
  return [optionsFacet.of(o), handlers, keymap.of([{ key: "Mod-Enter", run: (v) => followLinkAt(v) }]), richTheme];
}

/** Rich mode reads like a note: proportional text, code stays monospace. */
const prose = [EditorView.editorAttributes.of({ class: "cm-md-prose" }), proseTheme];

export const richMarkdown = (): Extension => [tableSource, richField, enterBlocks, focusEnteredTable, prose];
