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
import { select, workspace } from "./workspace";

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
  const items: MenuItem[] = [{ label: t("menu.newFile"), run: () => void newFile(dir) }];
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
