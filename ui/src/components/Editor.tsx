import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createMemo, For, onCleanup, onMount, Show } from "solid-js";
import { parentPath } from "../lib/tree";
import {
  activate,
  attachView,
  closeTab,
  detachView,
  focusGroup,
  groups,
  keepMine,
  reloadFromDisk,
  tabs,
  type Tab,
} from "../state/editor";
import { t } from "../lib/i18n";
import { modLabel } from "../lib/platform";
import { Home } from "./Home";
import { Kanban } from "./Kanban";
import { centerView } from "../state/ui";
import { TabStrip } from "./TabStrip";

/** Tab label; adds the parent folder when two open files share a name. */
function label(tab: Tab, all: Tab[]): string {
  const twin = all.some((t) => t !== tab && t.name === tab.name);
  const parent = parentPath(tab.path);
  return twin && parent ? `${tab.name} ‹${parent.slice(parent.lastIndexOf("/") + 1)}›` : tab.name;
}

export function Editor() {
  /** Files when any is open and no view was asked for; else home or the board. */
  const shown = () => (centerView() !== "auto" ? centerView() : tabs.length > 0 ? "file" : "home");
  const ids = createMemo(() => groups().panes.map((g) => g.id));

  return (
    <section class="editor">
      <div
        class="editor-groups"
        classList={{ hidden: shown() !== "file", stacked: groups().dir === "column" }}
      >
        <For each={ids()}>{(id) => <EditorGroup id={id} />}</For>
      </div>
      <Show when={shown() === "home"}>
        <Home />
      </Show>
      <Show when={shown() === "kanban"}>
        <Kanban />
      </Show>
    </section>
  );
}

/** One split of the editor: its tabs, its conflict banner and its own view. */
function EditorGroup(p: { id: number }) {
  let host!: HTMLDivElement;
  const group = createMemo(() => groups().panes.find((g) => g.id === p.id));
  const active = () => group()?.active ?? null;
  const tab = () => tabs.find((x) => x.path === active());
  const groupTabs = () => (group()?.tabs ?? []).map((path) => tabs.find((x) => x.path === path)).filter(Boolean) as Tab[];
  const multi = () => groups().panes.length > 1;
  const focused = () => groups().focused === p.id;

  onMount(() => {
    attachView(p.id, new EditorView({ parent: host, state: EditorState.create({ doc: "" }) }));
    onCleanup(() => detachView(p.id));
  });

  return (
    <div
      class="editor-group"
      classList={{ focused: focused() && multi(), dimmed: multi() && !focused() }}
      onFocusIn={() => focusGroup(p.id)}
      onMouseDown={() => focusGroup(p.id)}
    >
      <Show when={groupTabs().length > 0}>
        <TabStrip>
          <For each={groupTabs()}>
            {(tab, i) => (
              <div
                class="tab"
                role="tab"
                aria-selected={tab.path === active()}
                classList={{ active: tab.path === active() }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  if (e.button === 1) closeTab(tab.path);
                  else activate(tab.path);
                }}
                title={tab.path}
              >
                <span class="tab-num">{String(i() + 1).padStart(2, "0")}</span>
                <span class="tab-name">{label(tab, tabs)}</span>
                <button
                  class="tab-close"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    closeTab(tab.path);
                  }}
                  aria-label={t("hint.close")}
                >
                  {tab.dirty ? "●" : "×"}
                </button>
              </div>
            )}
          </For>
        </TabStrip>
      </Show>
      <Show when={tab()?.conflict}>
        {(kind) => (
          <div class="banner">
            <Show
              when={kind() === "changed"}
              fallback={<span class="danger">{t("editor.deleted")}</span>}
            >
              <span class="warn">{t("editor.changed")}</span>
              <button class="banner-btn" onClick={() => reloadFromDisk(active()!)}>
                {t("editor.reload")}
              </button>
              <button class="banner-btn" onClick={() => keepMine(active()!)}>
                {t("editor.keep")}
              </button>
            </Show>
          </div>
        )}
      </Show>
      <div class="box" classList={{ hidden: !active() }}>
        <div class="box-title">{active()}</div>
        <div ref={host} class="editor-host" />
      </div>
      <Show when={!active()}>
        <div class="editor-empty">
          <div>
            <span class="kbd">{modLabel}P</span> <span class="dim">{t("editor.openHere")}</span>
          </div>
          <div>
            <span class="kbd">:q</span> <span class="dim">{t("editor.closeSplit")}</span>
          </div>
        </div>
      </Show>
    </div>
  );
}
