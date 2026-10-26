import type { MergeView } from "@codemirror/merge";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { mountMerge } from "../lib/merge-view";
import { t } from "../lib/i18n";
import { modLabel } from "../lib/platform";
import { core, errorMessage, type SessionChange } from "../lib/ipc";
import { MARK_GLYPH } from "../lib/marks";
import { displayName } from "../lib/sessions";
import { shortPath } from "../lib/text";
import { openFile } from "../state/editor";
import { changes, refresh } from "../state/changes";
import * as sessions from "../state/sessions";
import { diffSession, setCenterView } from "../state/ui";

/**
 * A session's changes for review: the files on the left, the selected one
 * side by side (base | now). Keys: j/k pick a file, Enter or l jumps into the
 * diff, h back to the list, o opens it in the editor, r refreshes, Esc leaves.
 */
export function Diff() {
  let list!: HTMLDivElement;
  let host!: HTMLDivElement;
  const session = () => sessions.byId(diffSession());
  const files = () => changes[diffSession() ?? ""]?.files ?? [];
  const [index, setIndex] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const current = createMemo(() => files()[Math.min(index(), files().length - 1)] as SessionChange | undefined);
  let merge: MergeView | null = null;

  onMount(() => {
    const id = diffSession();
    if (id) refresh(id, 0);
    list.focus();
  });
  onCleanup(() => merge?.destroy());

  // A new file to show: fetch both sides and build the view.
  createEffect(
    on(
      () => [diffSession(), current()?.path] as const,
      async ([id, path]) => {
        merge?.destroy();
        merge = null;
        setError(null);
        if (!id || !path) return;
        let diff;
        try {
          diff = await core.sessionFileDiff(id, path);
        } catch (e) {
          return setError(errorMessage(e));
        }
        if (current()?.path !== path) return; // moved on meanwhile
        merge = mountMerge(host, path, diff.old, diff.new);
      },
    ),
  );

  const move = (d: number) => setIndex((i) => Math.max(0, Math.min(files().length - 1, i + d)));
  const openInEditor = () => {
    const f = current();
    // A worktree's file is not the workspace's: only in-place sessions open in the editor.
    if (f?.wsPath && !session()?.worktree) void openFile(f.wsPath);
  };

  const onKey = (e: KeyboardEvent) => {
    const inList = e.currentTarget === list;
    const k = e.key;
    if (k === "Escape") setCenterView("auto");
    else if (inList && (k === "j" || k === "ArrowDown")) move(1);
    else if (inList && (k === "k" || k === "ArrowUp")) move(-1);
    else if (inList && (k === "Enter" || k === "l")) (merge?.b.contentDOM ?? host).focus();
    else if (!inList && k === "h") list.focus();
    else if (k === "o") openInEditor();
    else if (k === "r") {
      const id = diffSession();
      if (id) refresh(id, 0);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div class="diff">
      <div class="box diff-files">
        <div class="box-title">
          {t("diff.title")}
          <Show when={session()}>{(s) => <span class="dim"> · {displayName(s())}</span>}</Show>
          <span class="count">{files().length}</span>
        </div>
        <div ref={list} class="diff-list" tabindex={0} onKeyDown={onKey}>
          <For each={files()} fallback={<div class="home-empty">{t("diff.none")}</div>}>
            {(f, i) => (
              <button
                class="diff-row"
                classList={{ selected: i() === index() }}
                tabindex={-1}
                title={f.path}
                onClick={() => {
                  setIndex(i());
                  list.focus();
                }}
                onDblClick={openInEditor}
              >
                <span class={`tree-mark-inline ${f.kind}`}>{MARK_GLYPH[f.kind]}</span>
                <span class="diff-name">{f.path}</span>
              </button>
            )}
          </For>
        </div>
        <div class="diff-meta faint">
          <Show when={changes[diffSession() ?? ""]}>
            {(c) => (
              <>
                {shortPath(c().root)}
                <Show when={c().base}>{(b) => <> · {t("diff.base")} {b().slice(0, 8)}</>}</Show>
              </>
            )}
          </Show>
        </div>
      </div>
      <div class="box diff-view" onKeyDown={onKey}>
        <button class="box-close" title={t("view.close", { mod: modLabel })} aria-label={t("view.close", { mod: modLabel })} onClick={() => setCenterView("auto")}>
          ×
        </button>
        <div class="box-title">
          <Show when={current()} fallback={t("diff.title")}>
            {(f) => (
              <>
                <span class="faint">{t("diff.before")}</span> {f().path} <span class="faint">{t("diff.after")}</span>
              </>
            )}
          </Show>
        </div>
        <Show when={error()}>
          <div class="banner">
            <span class="danger">{error()}</span>
          </div>
        </Show>
        <div ref={host} class="diff-host" />
      </div>
    </div>
  );
}
