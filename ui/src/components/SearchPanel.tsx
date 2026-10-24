import { createEffect, createSignal, For, on, onMount, Show } from "solid-js";
import { segmentsFromRanges } from "../lib/highlight";
import { core, errorMessage, type SearchResults } from "../lib/ipc";
import { load, save } from "../lib/storage";
import { openFile } from "../state/editor";
import { searchFocus } from "../state/ui";
import { workspace } from "../state/workspace";
import { t } from "../lib/i18n";

const DEBOUNCE_MS = 200;

interface Flags {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** Workspace text search; runs in the core, newer queries cancel older ones. */
export function SearchPanel() {
  let input!: HTMLInputElement;
  const [query, setQuery] = createSignal("");
  const [flags, setFlags] = createSignal<Flags>(load("searchFlags", { regex: false, caseSensitive: false, wholeWord: false }));
  const [results, setResults] = createSignal<SearchResults | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [elapsed, setElapsed] = createSignal(0);

  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    clearTimeout(timer);
    const q = query();
    const mine = ++seq;
    if (!q || !workspace()) {
      setResults(null);
      setError(null);
      return;
    }
    setBusy(true);
    const t0 = performance.now();
    try {
      const r = await core.searchText(q, { ...flags(), maxResults: 2000 });
      if (mine !== seq || r.cancelled) return;
      setResults(r);
      setError(null);
      setElapsed(Math.round(performance.now() - t0));
    } catch (e) {
      if (mine === seq) setError(errorMessage(e));
    } finally {
      if (mine === seq) setBusy(false);
    }
  };

  createEffect(
    on([query, flags, workspace], () => {
      clearTimeout(timer);
      timer = setTimeout(run, DEBOUNCE_MS);
    }, { defer: true }),
  );

  createEffect(on(searchFocus, () => (input.focus(), input.select()), { defer: true }));
  onMount(() => input.focus());

  const toggle = (k: keyof Flags) => {
    const next = { ...flags(), [k]: !flags()[k] };
    setFlags(next);
    save("searchFlags", next);
  };

  return (
    <section class="search">
      <div class="panel-title">
        <Show when={!results() && !busy()}>
          <span class="faint">{t("search.idle")}</span>
        </Show>
        <Show when={busy()}>
          <span class="faint">…</span>
        </Show>
        <Show when={results() && !busy()}>
          <span class="faint">
            {t("search.summary", { total: results()!.total, files: results()!.files.length, ms: elapsed() })}
            {results()!.truncated ? t("search.truncated") : ""}
          </span>
        </Show>
      </div>
      <div class="search-input">
        <span class="accent">/</span>
        <input
          ref={input}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
          placeholder={t("search.placeholder")}
          spellcheck={false}
          autocomplete="off"
        />
        <button class="toggle" aria-pressed={flags().caseSensitive} title={t("search.case")} onClick={() => toggle("caseSensitive")}>
          Aa
        </button>
        <button class="toggle" aria-pressed={flags().wholeWord} title={t("search.word")} onClick={() => toggle("wholeWord")}>
          W
        </button>
        <button class="toggle" aria-pressed={flags().regex} title={t("search.regex")} onClick={() => toggle("regex")}>
          .*
        </button>
      </div>
      <Show when={error()}>
        <div class="search-error danger">{error()}</div>
      </Show>
      <div class="search-results">
        <For each={results()?.files ?? []}>
          {(file) => (
            <div class="search-file">
              <div class="search-path" title={file.path}>
                {file.path} <span class="faint">{file.lines.length}</span>
              </div>
              <For each={file.lines}>
                {(m) => (
                  <button
                    class="search-line"
                    onClick={() => {
                      const len = m.ranges[0] ? m.ranges[0][1] - m.ranges[0][0] : 0;
                      void openFile(file.path, { line: m.line, col: m.column + 1, length: len });
                    }}
                  >
                    <span class="search-lnum">{m.line}</span>
                    <span class="search-text">
                      <For each={segmentsFromRanges(m.text, m.ranges)}>
                        {(seg) => (seg.hit ? <span class="match">{seg.text}</span> : seg.text)}
                      </For>
                    </span>
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </section>
  );
}
