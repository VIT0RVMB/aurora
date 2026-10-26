import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { t, type Key } from "../lib/i18n";
import { menu, prompt, setMenu, type MenuItem, type MenuRequest, type PromptRequest } from "../state/ui";

type Action = Extract<MenuItem, { run: () => void }>;
const isAction = (i: MenuItem): i is Action => "run" in i;

/** Right-click menu: j/k or arrows pick, Enter runs, Esc or a click outside closes. */
export function ContextMenu(p: { req: MenuRequest }) {
  let box!: HTMLDivElement;
  const actions = () => p.req.items.filter(isAction);
  const [cursor, setCursor] = createSignal(-1);
  const [pos, setPos] = createSignal({ left: p.req.x, top: p.req.y });
  const close = () => setMenu(null);
  const run = (i: Action) => {
    close();
    i.run();
  };

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    const n = actions().length;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown" || e.key === "j") setCursor((c) => (c + 1) % n);
    else if (e.key === "ArrowUp" || e.key === "k") setCursor((c) => (c <= 0 ? n - 1 : c - 1));
    else if (e.key === "Enter" && cursor() >= 0) run(actions()[cursor()]);
    else return;
    e.preventDefault();
  };

  onMount(() => {
    // Kept inside the window.
    const r = box.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(p.req.x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(p.req.y, window.innerHeight - r.height - 4)),
    });
    window.addEventListener("keydown", onKey, true);
    box.focus();
  });
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <div class="menu-backdrop" onMouseDown={close} onContextMenu={(e) => (e.preventDefault(), close())}>
      <div
        ref={box}
        class="menu"
        role="menu"
        tabindex={-1}
        style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Show when={p.req.title}>
          <div class="menu-title">{p.req.title}</div>
        </Show>
        <For each={p.req.items}>
          {(item) => (
            <Switch>
              <Match when={"separator" in item}>
                <div class="menu-sep" />
              </Match>
              <Match when={"colors" in item && item}>
                {(c) => {
                  const row = c() as Extract<MenuItem, { colors: string[] }>;
                  return (
                    <div class="menu-colors">
                      <span class="faint">{t("menu.color")}</span>
                      <button
                        class="swatch none"
                        classList={{ current: row.current == null }}
                        title={t("menu.noColor")}
                        onClick={() => (close(), row.pick(null))}
                      >
                        ⌀
                      </button>
                      <For each={row.colors}>
                        {(color) => (
                          <button
                            class={`swatch sc-${color}`}
                            classList={{ current: row.current === color }}
                            title={t(`color.${color}` as Key)}
                            onClick={() => (close(), row.pick(color))}
                          />
                        )}
                      </For>
                    </div>
                  );
                }}
              </Match>
              <Match when={isAction(item) && item}>
                {(a) => (
                  <button
                    class="menu-item"
                    classList={{ selected: actions()[cursor()] === a(), danger: a().tone === "danger" }}
                    role="menuitem"
                    onMouseEnter={() => setCursor(actions().indexOf(a()))}
                    onClick={() => run(a())}
                  >
                    <span>{a().label}</span>
                    <Show when={a().hint}>
                      <span class="faint">{a().hint}</span>
                    </Show>
                  </button>
                )}
              </Match>
            </Switch>
          )}
        </For>
      </div>
    </div>
  );
}

/** One line of text (a new name, a file path); Enter accepts, Esc cancels. */
export function Prompt(p: { req: PromptRequest }) {
  let input!: HTMLInputElement;
  onMount(() => {
    input.focus();
    const [a, b] = p.req.select ?? [0, p.req.value.length];
    input.setSelectionRange(a, b);
  });
  return (
    <div class="palette-backdrop" onMouseDown={() => p.req.resolve(null)}>
      <form
        class="palette prompt"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          const v = input.value.trim();
          p.req.resolve(v || null);
        }}
      >
        <div class="palette-input">
          <b>{p.req.title}</b>
          <input
            ref={input}
            value={p.req.value}
            spellcheck={false}
            autocomplete="off"
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                p.req.resolve(null);
              }
            }}
          />
        </div>
        <div class="prompt-hint faint">{t("prompt.hint")}</div>
      </form>
    </div>
  );
}

/** Mount point for both, in App. */
export function Overlays() {
  return (
    <>
      <Show when={menu()} keyed>
        {(req) => <ContextMenu req={req} />}
      </Show>
      <Show when={prompt()} keyed>
        {(req) => <Prompt req={req} />}
      </Show>
    </>
  );
}
