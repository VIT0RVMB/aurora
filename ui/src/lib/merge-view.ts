// Side-by-side diff with the editor's look, shared by the session diff and file history.
import { MergeView } from "@codemirror/merge";
import { languageFor, languageSlot, viewerExtensions } from "./editor-setup";

/** Mounts `before | after` in `parent`; the language for `path` loads after. */
export function mountMerge(parent: HTMLElement, path: string, before: string | null, after: string | null): MergeView {
  const view = new MergeView({
    parent,
    a: { doc: before ?? "", extensions: viewerExtensions() },
    b: { doc: after ?? "", extensions: viewerExtensions() },
    highlightChanges: true,
    gutter: true,
    collapseUnchanged: { margin: 3, minSize: 6 },
  });
  const lang = languageFor(path);
  if (lang) {
    void lang.load().then((support) => {
      // Gone already (another file picked): nothing to configure.
      if (!view.dom.isConnected) return;
      for (const v of [view.a, view.b]) v.dispatch({ effects: languageSlot.reconfigure(support) });
    });
  }
  return view;
}
