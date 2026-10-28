import { batch, createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { core, errorMessage, type DirEntry, type FsBatch, type WorkspaceInfo } from "../lib/ipc";
import { load, save } from "../lib/storage";
import { ancestors } from "../lib/tree";
import { notify } from "./ui";
import { t } from "../lib/i18n";

const RECENT_MAX = 8;

export const [workspace, setWorkspace] = createSignal<WorkspaceInfo | null>(null);
export const [recent, setRecent] = createSignal<string[]>(load("recent", []));

interface TreeState {
  children: Record<string, DirEntry[] | undefined>;
  expanded: Record<string, true | undefined>;
  selected: string | null;
}

export const [tree, setTree] = createStore<TreeState>({ children: {}, expanded: {}, selected: null });

export async function openWorkspace(path: string): Promise<boolean> {
  try {
    const info = await core.openWorkspace(path);
    batch(() => {
      setTree({ children: {}, expanded: {}, selected: null });
      setWorkspace(info);
    });
    const list = [info.root, ...recent().filter((r) => r !== info.root)].slice(0, RECENT_MAX);
    setRecent(list);
    save("recent", list);
    await loadDir("");
    return true;
  } catch (e) {
    notify(t("ws.openFailed", { path, err: errorMessage(e) }), "error");
    return false;
  }
}

export function forgetRecent(path: string) {
  const list = recent().filter((r) => r !== path);
  setRecent(list);
  save("recent", list);
}

export async function loadDir(path: string) {
  try {
    const entries = await core.listDir(path);
    setTree("children", path, entries);
  } catch {
    // Directory vanished: drop it and anything below.
    setTree(
      produce((s) => {
        for (const k of Object.keys(s.children)) if (k === path || k.startsWith(`${path}/`)) delete s.children[k];
        delete s.expanded[path];
      }),
    );
  }
}

export function setExpanded(path: string, open: boolean) {
  setTree("expanded", path, open ? true : undefined);
  if (open && !tree.children[path]) void loadDir(path);
}

/** Reloads every listing already loaded (the watcher may have missed a change). */
export async function refreshTree() {
  await Promise.all(Object.keys(tree.children).map(loadDir));
}

/** Folds every open folder. */
export function collapseAll() {
  setTree("expanded", reconcile({}));
}

export function select(path: string | null) {
  setTree("selected", path);
}

/** Expands every ancestor of `path` and selects it, so the tree follows the editor. */
export async function reveal(path: string) {
  for (const dir of ancestors(path)) {
    setTree("expanded", dir, true);
    if (!tree.children[dir]) await loadDir(dir);
  }
  select(path);
}

/** Reloads listings that changed on disk, only for directories already loaded. */
export function applyFsBatch(b: FsBatch) {
  const loaded = Object.keys(tree.children);
  const dirs = b.rescan ? loaded : b.dirs.filter((d) => tree.children[d]);
  for (const d of dirs) void loadDir(d);
}
