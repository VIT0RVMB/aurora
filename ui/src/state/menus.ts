// What right-clicking a session or a file offers. The same session menu shows
// on its terminal tab, its row in the sessions panel, its kanban card and the
// home screen.
import { t } from "../lib/i18n";
import { core, errorMessage, SESSION_COLORS, type SessionInfo } from "../lib/ipc";
import { displayName } from "../lib/sessions";
import { baseName, parentPath } from "../lib/tree";
import * as editor from "./editor";
import * as sessions from "./sessions";
import { isMac } from "../lib/platform";
import { ask, confirm, notify, openDiff, openHistory, openMenu, type MenuItem } from "./ui";
import { loadDir, reveal, select, setExpanded, tree, workspace } from "./workspace";

const report = (err: string | void) => err && notify(err, "error");

export async function renameSession(s: SessionInfo) {
  const name = await ask({ title: t("menu.renameSession"), value: displayName(s) });
  if (name && name !== displayName(s)) report(await sessions.rename(s, name));
}

/** Stops the agent's process, after asking; its history, worktree and card stay. */
export async function endSession(s: SessionInfo) {
  const choice = await confirm({
    title: t("menu.endTitle", { name: displayName(s) }),
    lines: [
      { text: t("menu.endKeeps") },
      ...(s.status === "running" ? [{ text: t("menu.endBusy"), tone: "warn" as const }] : []),
    ],
    options: [
      { key: "e", label: t("menu.end"), tone: "danger" },
      { key: "c", label: t("cancel") },
    ],
  });
  if (choice === "e") report(await sessions.kill(s));
}

export function sessionMenu(e: MouseEvent, s: SessionInfo) {
  const items: MenuItem[] = [
    { label: t("menu.renameSession"), run: () => void renameSession(s) },
    { colors: SESSION_COLORS, current: s.color ?? null, pick: (c) => void sessions.setColor(s, c).then(report) },
    { separator: true },
    { label: t("menu.showChanges"), run: () => openDiff(s.id) },
    s.archived
      ? { label: t("menu.unarchive"), run: () => void sessions.setArchived(s, false).then(report) }
      : { label: t("menu.archive"), run: () => void sessions.setArchived(s, true).then(report) },
    { separator: true },
    ...(s.alive ? [{ label: t("menu.endSession"), tone: "danger" as const, run: () => void endSession(s) }] : []),
    { label: t("menu.removeSession"), tone: "danger", run: () => void sessions.remove(s).then(report) },
  ];
  openMenu(e, items, displayName(s));
}

// ── several sessions at once (the sessions panel's selection) ──────────────

/** Runs `f` on every session; reports failures and returns how many worked. */
async function settle(list: SessionInfo[], f: (s: SessionInfo) => Promise<string | void>): Promise<number> {
  const errors = (await Promise.all(list.map(f))).filter((e): e is string => !!e);
  for (const e of errors) report(e);
  return list.length - errors.length;
}

export async function archiveMany(list: SessionInfo[], archived: boolean) {
  if (list.length === 1) return report(await sessions.setArchived(list[0], archived));
  const ok = await settle(list, (s) => sessions.setArchived(s, archived, true));
  if (ok) notify(t(archived ? "bulk.archived" : "bulk.unarchived", { n: ok }));
}

/** Stops the live ones, after one confirmation. */
export async function endMany(list: SessionInfo[]) {
  const alive = list.filter((s) => s.alive);
  if (alive.length <= 1) return alive[0] && endSession(alive[0]);
  const busy = alive.filter((s) => s.status === "running").length;
  const choice = await confirm({
    title: t("bulk.endTitle", { n: alive.length }),
    lines: [
      { text: t("menu.endKeeps") },
      ...(busy ? [{ text: t("bulk.endBusy", { n: busy }), tone: "warn" as const }] : []),
    ],
    options: [
      { key: "e", label: t("menu.end"), tone: "danger" },
      { key: "c", label: t("cancel") },
    ],
  });
  if (choice !== "e") return;
  const ok = await settle(alive, sessions.kill);
  if (ok) notify(t("bulk.ended", { n: ok }));
}

/** Removes them after one confirmation, which also decides about their worktrees. */
export async function removeMany(list: SessionInfo[]) {
  if (list.length === 1) return report(await sessions.remove(list[0]));
  const withTree = list.filter((s) => s.worktree);
  let dirty: Set<string>;
  try {
    const flags = await Promise.all(withTree.map((s) => core.sessionWorktreeDirty(s.id)));
    dirty = new Set(withTree.filter((_, i) => flags[i]).map((s) => s.id));
  } catch (e) {
    return report(errorMessage(e));
  }
  const alive = list.filter((s) => s.alive).length;
  const choice = await confirm({
    title: t("bulk.removeTitle", { n: list.length }),
    lines: [
      ...(alive ? [{ text: t("bulk.stillRunning", { n: alive }), tone: "warn" as const }] : []),
      ...(withTree.length ? [{ text: t("bulk.worktrees", { n: withTree.length }), tone: "dim" as const }] : []),
      ...(dirty.size ? [{ text: t("bulk.dirty", { n: dirty.size }), tone: "danger" as const }] : []),
    ],
    options: withTree.length
      ? [
          { key: "w", label: t("bulk.removeBoth"), tone: dirty.size ? "danger" : "accent" },
          { key: "s", label: t("bulk.onlySessions") },
          { key: "c", label: t("cancel") },
        ]
      : [
          { key: "r", label: t("bulk.remove"), tone: "danger" },
          { key: "c", label: t("cancel") },
        ],
  });
  if (choice !== "w" && choice !== "s" && choice !== "r") return;
  const trees = choice === "w";
  const ok = await settle(list, (s) => sessions.removeNow(s, trees && !!s.worktree, trees && dirty.has(s.id)));
  if (ok) notify(t("bulk.removed", { n: ok }));
}

/** Right-click on a selection of several sessions. */
export function sessionsMenu(e: MouseEvent, list: SessionInfo[]) {
  const after = (p: Promise<unknown>) => void p;
  const archived = list.every((s) => s.archived);
  const items: MenuItem[] = [
    archived
      ? { label: t("menu.unarchive"), run: () => after(archiveMany(list, false)) }
      : { label: t("menu.archive"), run: () => after(archiveMany(list, true)) },
    { separator: true },
    ...(list.some((s) => s.alive)
      ? [{ label: t("menu.endSession"), tone: "danger" as const, run: () => after(endMany(list)) }]
      : []),
    { label: t("menu.removeSession"), tone: "danger", run: () => after(removeMany(list)) },
  ];
  openMenu(e, items, t("sessions.selected", { n: list.length }));
}

/** Selects the name without its extension, like Finder and VS Code. */
function stemRange(path: string): [number, number] {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  const start = path.length - name.length;
  return [start, dot > 0 ? start + dot : path.length];
}

export async function newFile(dir: string) {
  const prefix = dir ? `${dir}/` : "";
  const path = await ask({ title: t("menu.newFile"), value: prefix, select: [prefix.length, prefix.length] });
  if (!path || path.endsWith("/")) return;
  try {
    await core.createFile(path);
    await editor.openFile(path);
    select(path);
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

/** Where the tree's new file / folder buttons create: the selected folder, or the selected file's. */
export function selectedDir(): string {
  const sel = tree.selected;
  if (!sel) return "";
  const entry = tree.children[parentPath(sel)]?.find((e) => e.path === sel);
  return entry?.isDir ? sel : parentPath(sel);
}

export async function newFolder(dir: string) {
  const prefix = dir ? `${dir}/` : "";
  const typed = await ask({ title: t("menu.newFolder"), value: prefix, select: [prefix.length, prefix.length] });
  const path = typed?.replace(/\/+$/, "");
  if (!path || path === dir) return;
  try {
    await core.createDir(path);
    // Not waiting for the watcher: the new folder shows (and is selected) now.
    await loadDir(parentPath(path));
    await reveal(path);
    setExpanded(path, true);
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

export async function renameFile(path: string) {
  const to = await ask({ title: t("menu.rename"), value: path, select: stemRange(path) });
  if (!to || to === path) return;
  try {
    await core.renamePath(path, to);
    editor.renamePath(path, to);
    select(to);
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

/** Platform name of the file manager, for "Show in …". */
const revealLabel = () =>
  isMac ? t("menu.revealFinder") : /Win/.test(navigator.platform) ? t("menu.revealExplorer") : t("menu.revealFolder");

const run = (p: Promise<unknown>) => void p.catch((e) => notify(errorMessage(e), "error"));

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify(t("menu.copied", { what }));
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

function absolute(path: string): string {
  const root = workspace()?.root ?? "";
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return path ? `${root.replace(/[\\/]+$/, "")}${sep}${path.split("/").join(sep)}` : root;
}

async function shareLink(path: string) {
  try {
    await copy(await core.shareLink(path), t("menu.link"));
  } catch (e) {
    notify(t("menu.noLink", { err: errorMessage(e) }), "warn");
  }
}

/** To the system trash (recoverable), after asking; open tabs under it close. */
export async function deletePath(path: string, isDir: boolean) {
  const dirty = editor.tabsUnder(path).filter((x) => x.dirty);
  const choice = await confirm({
    title: t(isDir ? "menu.deleteFolderTitle" : "menu.deleteTitle", { name: baseName(path) }),
    lines: [
      { text: path, tone: "dim" },
      { text: t("menu.deleteTrash") },
      ...(dirty.length ? [{ text: t("menu.deleteDirty", { n: dirty.length }), tone: "warn" as const }] : []),
    ],
    options: [
      { key: "d", label: t("menu.delete"), tone: "danger" },
      { key: "c", label: t("cancel") },
    ],
  });
  if (choice !== "d") return;
  try {
    await core.trashPath(path);
    editor.closeUnder(path);
    notify(t("menu.trashed", { name: baseName(path) }));
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

/** A tree row (or the empty space below it, with no path). */
export function fileMenu(e: MouseEvent, entry: { path: string; isDir: boolean } | null) {
  const dir = !entry ? "" : entry.isDir ? entry.path : parentPath(entry.path);
  const items: MenuItem[] = [
    { label: t("menu.newFile"), run: () => void newFile(dir) },
    { label: t("menu.newFolder"), run: () => void newFolder(dir) },
  ];
  if (entry) {
    const { path, isDir } = entry;
    items.push(
      { separator: true },
      ...(isDir ? [] : [{ label: t("menu.history"), run: () => openHistory(path) }]),
      { label: t("menu.openDefault"), run: () => run(core.openPath(path)) },
      { label: revealLabel(), run: () => run(core.revealPath(path)) },
      { label: t("menu.copyPath"), run: () => void copy(absolute(path), t("menu.path")) },
      { label: t("menu.copyRelative"), run: () => void copy(path, t("menu.path")) },
      { label: t("menu.share"), run: () => void shareLink(path) },
      { separator: true },
      { label: t("menu.rename"), run: () => void renameFile(path) },
      { separator: true },
      { label: t("menu.delete"), tone: "danger", run: () => void deletePath(path, isDir) },
    );
  } else {
    items.push({ label: revealLabel(), run: () => run(core.revealPath("")) });
  }
  openMenu(e, items, entry ? baseName(entry.path) : workspace()?.name);
}
