import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { findCommand, lineToRun, parseCommand, suggest, type CommandSpec, type Suggestion } from "../lib/commands";
import { segmentsFromIndices } from "../lib/highlight";
import { core, type FuzzyMatch } from "../lib/ipc";
import { openFile } from "../state/editor";
import { palette, setPalette } from "../state/ui";
import { workspace } from "../state/workspace";
import { t } from "../lib/i18n";

interface Props {
  commands: CommandSpec[];
  /** Runs a command line; resolves to an error message or nothing on success. */
  run: (line: string) => Promise<string | void>;
}

/** One input, two modes: fuzzy file finder, or the `:` command line. */
export function Palette(p: Props) {
  let input!: HTMLInputElement;
  const [text, setText] = createSignal(palette()?.initial ?? "");
  const [index, setIndex] = createSignal(0);
  /** The highlighted suggestion was chosen (arrows, click), not just the first one. */
  const [picked, setPicked] = createSignal(false);
  const [files, setFiles] = createSignal<FuzzyMatch[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const isCommand = () => text().startsWith(":");

  const suggestions = createMemo<Suggestion[]>(() => (isCommand() ? suggest(p.commands, text()) : []));
  const count = () => (isCommand() ? suggestions().length : files().length);

  let seq = 0;
  createEffect(
    on(text, async (q) => {
      setIndex(0);
      setPicked(false);
      setError(null);
      if (q.startsWith(":") || !workspace()) return setFiles([]);
      const mine = ++seq;
      const res = await core.fuzzyFind(q, 50).catch(() => []);
      if (mine === seq) setFiles(res);
    }),
  );

  // Give the keyboard back (e.g. to vim) unless the command moved focus.
  const previous = document.activeElement as HTMLElement | null;
  onMount(() => input.focus());
  onCleanup(() => {
    queueMicrotask(() => {
      const now = document.activeElement;
      if ((!now || now === document.body) && previous?.isConnected) previous.focus();
    });
  });

  const close = () => setPalette(null);

  const accept = async () => {
    if (isCommand()) {
      const typed = text().trim();
      const s = suggestions()[index()];
      const name = parseCommand(typed)?.name.replace(/!$/, "") ?? "";
      const exact = !!findCommand(p.commands, name);
      const line = lineToRun(typed, s, picked(), exact);
      if (line === null) return setText(s!.value);
      const err = await p.run(line);
      if (err) setError(err);
      else close();
    } else {
      const f = files()[index()];
      if (!f) return;
      close();
      await openFile(f.path);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const n = count();
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      setIndex((i) => (n ? (i + 1) % n : 0));
      setPicked(true);
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      setIndex((i) => (n ? (i - 1 + n) % n : 0));
      setPicked(true);
    }
    else if (e.key === "Tab" && isCommand()) {
      const s = suggestions()[index()];
      if (s) setText(s.value);
    } else if (e.key === "Enter") void accept();
    else return;
    e.preventDefault();
  };

  return (
    <div class="palette-backdrop" onMouseDown={close}>
      <div class="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div class="palette-input">
          <span class="accent">{isCommand() ? "" : "›"}</span>
          <input
            ref={input}
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            placeholder={workspace() ? t("palette.files") : t("palette.noWorkspace")}
            spellcheck={false}
            autocomplete="off"
          />
        </div>
        <div class="palette-list">
          <Show when={isCommand()}>
            <For each={suggestions()}>
              {(s, i) => (
                <div
                  class="palette-item"
                  classList={{ selected: i() === index() }}
                  onMouseMove={() => setIndex(i())}
                  onClick={() => {
                    setIndex(i());
                    setPicked(true);
                    void accept();
                  }}
                >
                  <span>{s.label}</span>
                  <span class="dim">{s.description}</span>
                </div>
              )}
            </For>
          </Show>
          <Show when={!isCommand()}>
            <For each={files()}>
              {(f, i) => (
                <div
                  class="palette-item"
                  classList={{ selected: i() === index() }}
                  onMouseMove={() => setIndex(i())}
                  onClick={() => {
                    setIndex(i());
                    void accept();
                  }}
                >
                  <span>
                    <For each={segmentsFromIndices(f.path, f.indices)}>
                      {(seg) => (seg.hit ? <span class="match">{seg.text}</span> : seg.text)}
                    </For>
                  </span>
                </div>
              )}
            </For>
            <Show when={workspace() && text() && files().length === 0}>
              <div class="palette-item dim">{t("palette.noFiles")}</div>
            </Show>
          </Show>
        </div>
        <div class="palette-footer">
          <Show when={error()} fallback={<span class="faint">{t("palette.footer")}</span>}>
            <span class="danger">{error()}</span>
          </Show>
        </div>
      </div>
    </div>
  );
}
