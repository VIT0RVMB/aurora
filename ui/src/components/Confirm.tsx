import { For, onCleanup, onMount } from "solid-js";
import type { ConfirmRequest } from "../state/ui";

/** Modal question answered by a single key (or a click); Esc cancels. */
export function Confirm(p: { req: ConfirmRequest }) {
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") return e.preventDefault(), p.req.resolve(null);
    const opt = p.req.options.find((o) => o.key === e.key.toLowerCase());
    if (opt) {
      e.preventDefault();
      p.req.resolve(opt.key);
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <div class="palette-backdrop" onMouseDown={() => p.req.resolve(null)}>
      <div class="palette confirm" role="alertdialog" aria-label={p.req.title} onMouseDown={(e) => e.stopPropagation()}>
        <div class="palette-input">
          <b>{p.req.title}</b>
        </div>
        <div class="confirm-body">
          <For each={p.req.lines}>{(l) => <div class={l.tone ?? ""}>{l.text}</div>}</For>
        </div>
        <div class="confirm-options">
          <For each={p.req.options}>
            {(o) => (
              <button class={`confirm-option ${o.tone ?? ""}`} onClick={() => p.req.resolve(o.key)}>
                [{o.key}] {o.label}
              </button>
            )}
          </For>
          <span class="faint">esc cancela</span>
        </div>
      </div>
    </div>
  );
}
