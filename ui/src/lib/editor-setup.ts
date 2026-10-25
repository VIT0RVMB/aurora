import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { vim } from "@replit/codemirror-vim";

/** Per-state slot for the language, filled in asynchronously after load. */
export const languageSlot = new Compartment();
/** Vim keybindings, toggled with `:vim`. */
export const vimSlot = new Compartment();
export const vimExtension = () => vim({ status: false });

// Colors come from CSS tokens, so switching theme needs no reconfigure.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--syn-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.labelName], color: "var(--syn-property)" },
  { tag: [t.variableName, t.self], color: "var(--syn-variable)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--syn-operator)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--syn-tag)" },
  { tag: [t.attributeName], color: "var(--syn-attr)" },
  { tag: [t.heading], color: "var(--syn-heading)", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "var(--syn-link)", textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.strikethrough], textDecoration: "line-through" },
  { tag: [t.invalid], color: "var(--danger)" },
]);

const terminalTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--surface)", fontSize: "var(--font-size)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "var(--cell-h)" },
  ".cm-content": { caretColor: "var(--cursor)", padding: "0" },
  ".cm-line": { padding: "0 var(--cell-w)" },
  // Bar in insert mode (and without vim); vim's normal mode draws a block.
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--cursor)" },
  "& .cm-fat-cursor": { background: "var(--cursor) !important", color: "var(--accent-fg) !important" },
  "&:not(.cm-focused) .cm-fat-cursor": {
    background: "none !important",
    outline: "1px solid var(--cursor) !important",
    color: "transparent !important",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
    { backgroundColor: "var(--selection) !important" },
  ".cm-activeLine": { backgroundColor: "var(--bg-panel)" },
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--fg-faint)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 var(--cell-w) 0 calc(var(--cell-w) * 2)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-panel)", color: "var(--fg-dim)" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0", width: "calc(var(--cell-w) * 2)" },
  ".cm-matchingBracket": { color: "var(--accent) !important", backgroundColor: "var(--match-bg)" },
  ".cm-selectionMatch": { backgroundColor: "var(--match-bg)" },
  ".cm-searchMatch": { backgroundColor: "var(--match-bg)", outline: "1px solid var(--line-strong)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--bg-select)" },
  ".cm-panels": { backgroundColor: "var(--bg-panel)", color: "var(--fg)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-panel.cm-search": { padding: "0 var(--cell-w)", fontFamily: "var(--font-mono)" },
  ".cm-panel input, .cm-panel button, .cm-panel label": { fontSize: "inherit", fontFamily: "inherit" },
  ".cm-textfield": { border: "1px solid var(--line-strong)", backgroundColor: "var(--bg)", color: "var(--fg)" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg-raised)", border: "1px solid var(--line-strong)", color: "var(--fg)" },
  ".cm-tooltip": { backgroundColor: "var(--bg-raised)", border: "1px solid var(--line-strong)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-raised)", border: "none", color: "var(--fg-dim)" },
});

export interface StateOptions {
  doc: string;
  vim: boolean;
  crlf: boolean;
  onChange: () => void;
  onCursor: (line: number, col: number) => void;
}

export function createEditorState(o: StateOptions): EditorState {
  return EditorState.create({
    doc: o.doc,
    extensions: [
      // First, so vim keys win over the default keymap.
      vimSlot.of(o.vim ? vimExtension() : []),
      lineNumbers(),
      foldGutter({ openText: "▾", closedText: "▸" }),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(highlight),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: false }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
      terminalTheme,
      languageSlot.of([]),
      o.crlf ? EditorState.lineSeparator.of("\r\n") : [],
      EditorView.updateListener.of((u) => {
        if (u.docChanged) o.onChange();
        if (u.docChanged || u.selectionSet) {
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          o.onCursor(line.number, head - line.from + 1);
        }
      }),
    ],
  });
}

export function languageFor(path: string): LanguageDescription | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return LanguageDescription.matchFilename(languages, name);
}
