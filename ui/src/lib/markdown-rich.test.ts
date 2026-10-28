import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { linkAt, markdownSupport, richDecorations, richMarkdown } from "./markdown-rich";
import { tableSource, toggleTableSource } from "./markdown-table";

function state(doc: string, cursor = doc.length) {
  const s = EditorState.create({ doc, extensions: [markdownSupport()], selection: EditorSelection.cursor(cursor) });
  ensureSyntaxTree(s, s.doc.length, 5000);
  return s;
}

/** What the reader sees: the text with hidden ranges removed and widgets as `<name>`. */
function rendered(s: EditorState): string {
  const deco = richDecorations(s);
  let out = "";
  let at = 0;
  const cur = deco.iter();
  const replaced: [number, number, string][] = [];
  for (; cur.value; cur.next()) {
    const spec = cur.value.spec as { widget?: { constructor: { name: string } } };
    if (cur.from === cur.to && !spec.widget) continue; // line decorations
    if ((cur.value as unknown as { point: boolean }).point) {
      replaced.push([cur.from, cur.to, spec.widget ? `<${spec.widget.constructor.name.replace("Widget", "")}>` : ""]);
    }
  }
  for (const [from, to, w] of replaced) {
    if (from < at) continue;
    out += s.sliceDoc(at, from) + w;
    at = to;
  }
  return out + s.sliceDoc(at);
}

function lineClasses(s: EditorState): string[] {
  const out: string[] = [];
  for (const cur = richDecorations(s).iter(); cur.value; cur.next()) {
    const cls = (cur.value.spec as { class?: string }).class;
    if (cur.from === cur.to && cls) out.push(`${s.doc.lineAt(cur.from).number}:${cls}`);
  }
  return out;
}

describe("rich markdown", () => {
  it("hides markup away from the cursor and shows it on the cursor's line", () => {
    const doc = "# Title\n\nsome **bold** and `code` and ~~gone~~\n\nend";
    expect(rendered(state(doc))).toBe("Title\n\nsome bold and code and gone\n\nend");
    const onBold = state(doc, doc.indexOf("bold"));
    expect(rendered(onBold)).toBe("Title\n\nsome **bold** and `code` and ~~gone~~\n\nend");
    expect(lineClasses(state(doc))).toContain("1:cm-md-h cm-md-h1");
  });

  it("renders links, wiki links and lists", () => {
    const doc = "see [the docs](docs/a.md) and [[Notes|my notes]]\n- item\n- [x] done\n- [ ] todo\n\nx";
    expect(rendered(state(doc))).toBe("see the docs and my notes\n<Bullet> item\n<Task> done\n<Task> todo\n\nx");
    expect(lineClasses(state(doc))).toContain("3:cm-md-done");
  });

  it("keeps tables rendered under the cursor; mermaid opens when the cursor enters", () => {
    const doc = "| a | b |\n|---|--:|\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B\n```\n\nx";
    expect(rendered(state(doc))).toBe("<Table>\n\n<Mermaid>\n\nx");
    expect(rendered(state(doc, 2))).toBe("<Table>\n\n<Mermaid>\n\nx");
    expect(rendered(state(doc, doc.indexOf("graph")))).toBe("<Table>\n\n```mermaid\ngraph TD; A-->B\n```\n\nx");
  });

  it("shows one table's source when toggled", () => {
    const doc = "| a |\n|---|\n| 1 |\n\nx";
    let s = EditorState.create({ doc, extensions: [markdownSupport(), tableSource], selection: { anchor: doc.length } });
    ensureSyntaxTree(s, s.doc.length, 5000);
    s = s.update({ effects: toggleTableSource.of(0) }).state;
    expect(rendered(s)).toBe("| a |<SourceBack>\n|---|\n| 1 |\n\nx");
  });

  it("shows frontmatter as properties, or its source when toggled", () => {
    const doc = "---\ntitle: x\ntags: [a]\n---\n# Body [[y]]\n\nz";
    expect(rendered(state(doc))).toBe("<Frontmatter>\nBody y\n\nz");
    expect(rendered(state(doc, 2))).toBe("<Frontmatter>\nBody y\n\nz");
    let s = EditorState.create({ doc, extensions: [markdownSupport(), tableSource], selection: { anchor: doc.length } });
    ensureSyntaxTree(s, s.doc.length, 5000);
    s = s.update({ effects: toggleTableSource.of(0) }).state;
    expect(rendered(s)).toBe("---<SourceBack>\ntitle: x\ntags: [a]\n---\nBody y\n\nz");
    expect(lineClasses(s)).toContain("3:cm-md-frontmatter");
    expect(lineClasses(s).some((c) => c.startsWith("3:cm-md-h"))).toBe(false);
  });

  it("keeps code blocks as code, with the language as a label", () => {
    const doc = "```ts\nconst a = **1**;\n```\n\nx";
    expect(rendered(state(doc))).toBe("<Lang>\nconst a = **1**;\n\n\nx");
  });

  it("ignores wiki syntax inside code", () => {
    expect(rendered(state("`[[x]]` y\nz"))).toBe("[[x]] y\nz");
  });

  it("finds the link under the cursor", () => {
    const s = state("a [b](c.md#h) [[Wiki#x]] <https://e.com>");
    expect(linkAt(s, 3)).toEqual({ kind: "href", target: "c.md#h" });
    expect(linkAt(s, 17)).toEqual({ kind: "wiki", target: "Wiki#x" });
    expect(linkAt(s, 30)).toEqual({ kind: "href", target: "https://e.com" });
    expect(linkAt(s, 0)).toBeNull();
  });

  it("steps into a rendered block instead of over it", () => {
    const doc = "a\n\n| x |\n|---|\n| 1 |\n\nb";
    const at = (n: number) => EditorState.create({ doc }).doc.line(n).from;
    const lineAfter = (s: EditorState, n: number) => {
      const next = s.update({ selection: { anchor: at(n) } }).state;
      return next.doc.lineAt(next.selection.main.head).number;
    };
    let s = EditorState.create({ doc, extensions: [markdownSupport(), richMarkdown()] });
    ensureSyntaxTree(s, s.doc.length, 5000);
    // Moving to another line rebuilds the decorations over the full parse.
    s = s.update({ selection: { anchor: at(6) } }).state;
    expect(lineAfter(s, 2)).toBe(5); // up from the line below: onto the table's last line
    s = s.update({ selection: { anchor: at(1) } }).state;
    s = s.update({ selection: { anchor: at(2) } }).state;
    expect(lineAfter(s, 6)).toBe(3); // down from the line above: onto its first line
    expect(lineAfter(s, 7)).toBe(7); // a longer jump is left alone
  });
});
