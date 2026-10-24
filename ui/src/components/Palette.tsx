import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { findCommand, parseCommand, suggest, type CommandSpec, type Suggestion } from "../lib/commands";
import { segmentsFromIndices } from "../lib/highlight";
import { core, type FuzzyMatch } from "../lib/ipc";
import { openFile } from "../state/editor";
import { palette, setPalette } from "../state/ui";
import { workspace } from "../state/workspace";

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
  const [files, setFiles] = createSignal<FuzzyMatch[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const isCommand = () => text().startsWith(":");

  const suggestions = createMemo<Suggestion[]>(() => (isCommand() ? suggest(p.commands, text()) : []));
  const count = () => (isCommand() ? suggestions().length : files().length);

  let seq = 0;
  createEffect(
    on(text, async (q) => {
      setIndex(0);
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
      let line = typed;
      // A partial name (":th") resolves to the highlighted command first;
      // an exact name or alias (":q", ":w", ":q!") runs as typed.
      const name = parseCommand(typed)?.name.replace(/!$/, "") ?? "";
      const exact = !!findCommand(p.commands, name);
      if (s && !exact && !typed.includes(" ") && s.value.trim() !== typed) {
        if (s.value.endsWith(" ")) return setText(s.value);
        line = s.value;
      }
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
    else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setIndex((i) => (n ? (i + 1) % n : 0));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setIndex((i) => (n ? (i - 1 + n) % n : 0));
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
            placeholder={workspace() ? "arquivo… (: para comandos)" : ":open para abrir uma pasta"}
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
              <div class="palette-item dim">nenhum arquivo</div>
            </Show>
          </Show>
        </div>
        <div class="palette-footer">
          <Show when={error()} fallback={<span class="faint">↑↓ navegar · ⏎ abrir · tab completar · esc fechar</span>}>
            <span class="danger">{error()}</span>
          </Show>
        </div>
      </div>
    </div>
  );
}
