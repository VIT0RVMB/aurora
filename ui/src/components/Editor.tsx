import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { For, onMount, Show } from "solid-js";
import { modLabel } from "../lib/platform";
import { parentPath } from "../lib/tree";
import {
  activate,
  active,
  activeTab,
  attachView,
  closeTab,
  keepMine,
  reloadFromDisk,
  tabs,
  type Tab,
} from "../state/editor";
import { t } from "../lib/i18n";

/** Tab label; adds the parent folder when two open files share a name. */
function label(tab: Tab, all: Tab[]): string {
  const twin = all.some((t) => t !== tab && t.name === tab.name);
  const parent = parentPath(tab.path);
  return twin && parent ? `${tab.name} ‹${parent.slice(parent.lastIndexOf("/") + 1)}›` : tab.name;
}

export function Editor() {
  let host!: HTMLDivElement;

  onMount(() => {
    attachView(new EditorView({ parent: host, state: EditorState.create({ doc: "" }) }));
  });

  return (
    <section class="editor">
      <div class="tabbar" role="tablist">
        <For each={tabs}>
          {(tab, i) => (
            <div
              class="tab"
              role="tab"
              aria-selected={tab.path === active()}
              classList={{ active: tab.path === active() }}
              onMouseDown={(e) => {
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
                aria-label="fechar"
              >
                {tab.dirty ? "●" : "×"}
              </button>
            </div>
          )}
        </For>
      </div>
      <Show when={activeTab()?.conflict}>
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
      <Show when={active()}>
        <div class="pane-label">
          <span>editor</span>
          <span>{active()}</span>
        </div>
      </Show>
      <div ref={host} class="editor-host" classList={{ hidden: !active() }} />
      <Show when={!active()}>
        <div class="editor-empty">
          <div>
            <span class="kbd">{modLabel}P</span> <span class="dim">{t("empty.openFile")}</span>
          </div>
          <div>
            <span class="kbd">{modLabel}⇧F</span> <span class="dim">{t("empty.search")}</span>
          </div>
          <div>
            <span class="kbd">:</span> <span class="dim">{t("empty.commands")}</span>
          </div>
        </div>
      </Show>
    </section>
  );
}
