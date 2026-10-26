import type { MergeView } from "@codemirror/merge";
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { t } from "../lib/i18n";
import { modLabel } from "../lib/platform";
import { core, errorMessage, type Commit } from "../lib/ipc";
import { mountMerge } from "../lib/merge-view";
import { ago } from "../lib/text";
import { historyPath, now, setCenterView } from "../state/ui";

/**
 * A file's commits on the left, what the selected one changed on the right
 * (its parent | it). Keys: j/k pick, Enter or l into the diff, h back, Esc leaves.
 */
export function History() {
  let list!: HTMLDivElement;
  let host!: HTMLDivElement;
  const [commits] = createResource(historyPath, (p) => core.fileHistory(p).catch((e) => errorMessage(e)));
  const rows = createMemo(() => (Array.isArray(commits()) ? (commits() as Commit[]) : []));
  const failure = () => (typeof commits() === "string" ? (commits() as string) : null);
  const [index, setIndex] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const current = () => rows()[Math.min(index(), rows().length - 1)] as Commit | undefined;
  let merge: MergeView | null = null;

  onMount(() => list.focus());
  onCleanup(() => merge?.destroy());

  createEffect(
    on(
      () => current()?.hash,
      async (hash) => {
        merge?.destroy();
        merge = null;
        setError(null);
        const c = current();
        if (!hash || !c) return;
        try {
          const diff = await core.commitDiff(hash, c.path);
          if (current()?.hash !== hash) return;
          merge = mountMerge(host, c.path, diff.old, diff.new);
        } catch (e) {
          setError(errorMessage(e));
        }
      },
    ),
  );

  const onKey = (e: KeyboardEvent) => {
    const inList = e.currentTarget === list;
    const k = e.key;
    if (k === "Escape") setCenterView("auto");
    else if (inList && (k === "j" || k === "ArrowDown")) setIndex((i) => Math.min(rows().length - 1, i + 1));
    else if (inList && (k === "k" || k === "ArrowUp")) setIndex((i) => Math.max(0, i - 1));
    else if (inList && (k === "Enter" || k === "l")) (merge?.b.contentDOM ?? host).focus();
    else if (!inList && k === "h") list.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div class="diff">
      <div class="box diff-files">
        <div class="box-title">
          {t("history.title")}
          <span class="dim"> · {historyPath()}</span>
          <span class="count">{rows().length}</span>
        </div>
        <div ref={list} class="diff-list" tabindex={0} onKeyDown={onKey}>
          <Show when={failure()}>
            <div class="home-empty danger">{failure()}</div>
          </Show>
          <For each={rows()} fallback={<Show when={!failure() && !commits.loading}><div class="home-empty">{t("history.none")}</div></Show>}>
            {(c, i) => (
              <button
                class="diff-row history-row"
                classList={{ selected: i() === index() }}
                tabindex={-1}
                title={`${c.hash}\n${c.author}\n${c.path}`}
                onClick={() => {
                  setIndex(i());
                  list.focus();
                }}
              >
                <span class="accent">{c.short}</span>
                <span class="diff-name">{c.subject}</span>
                <span class="faint history-meta">
                  {c.author} · {ago(c.timeMs, now())}
                </span>
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="box diff-view" onKeyDown={onKey}>
        <button class="box-close" title={t("view.close", { mod: modLabel })} aria-label={t("view.close", { mod: modLabel })} onClick={() => setCenterView("auto")}>
          ×
        </button>
        <div class="box-title">
          <Show when={current()} fallback={t("history.title")}>
            {(c) => (
              <>
                <span class="faint">{c().short}^ ·</span> {c().path} <span class="faint">· {c().short}</span>
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
