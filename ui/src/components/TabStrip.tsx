import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";

/**
 * Row of tabs that scrolls sideways; `‹` and `›` appear at the ends when some
 * tabs don't fit, and the active tab is kept in view.
 */
export function TabStrip(p: { children: JSX.Element; pane?: number; kind?: string }) {
  let row!: HTMLDivElement;
  const [left, setLeft] = createSignal(false);
  const [right, setRight] = createSignal(false);
  const measure = () => {
    setLeft(row.scrollLeft > 0);
    setRight(row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
  };
  const scroll = (dir: number) => row.scrollBy({ left: dir * row.clientWidth * 0.7, behavior: "smooth" });

  onMount(() => {
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    // Tabs coming and going, or a new active one: re-measure and reveal it.
    const mo = new MutationObserver(() => {
      row.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
      measure();
    });
    mo.observe(row, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    measure();
    onCleanup(() => (ro.disconnect(), mo.disconnect()));
  });

  return (
    <div class="tabstrip">
      <Show when={left()}>
        <button class="tabstrip-arrow" tabindex={-1} onMouseDown={(e) => (e.stopPropagation(), scroll(-1))}>
          ‹
        </button>
      </Show>
      <div ref={row} class="tabbar" role="tablist" onScroll={measure} data-tabs-pane={p.pane} data-kind={p.kind}>
        {p.children}
      </div>
      <Show when={right()}>
        <button class="tabstrip-arrow" tabindex={-1} onMouseDown={(e) => (e.stopPropagation(), scroll(1))}>
          ›
        </button>
      </Show>
    </div>
  );
}
