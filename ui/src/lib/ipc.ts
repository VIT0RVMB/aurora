// Typed wrappers over the core's Tauri commands. The UI never touches the
// filesystem or processes directly; everything goes through here.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { errorText } from "./i18n";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** Ignored by git: shown dimmed, absent from fuzzy open and search. */
  ignored?: boolean;
}

export interface FileStat {
  mtimeMs: number;
  size: number;
}

export interface FileContent {
  content: string;
  stat: FileStat;
}

export interface FuzzyMatch {
  path: string;
  score: number;
  indices: number[];
}

export interface SearchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  maxResults?: number;
}

export interface LineMatch {
  line: number;
  text: string;
  ranges: [number, number][];
  column: number;
}

export interface FileMatches {
  path: string;
  lines: LineMatch[];
}

export interface SearchResults {
  files: FileMatches[];
  total: number;
  truncated: boolean;
  cancelled: boolean;
}

export interface FsBatch {
  changed: string[];
  dirs: string[];
  rescan: boolean;
}

export interface WorkspaceInfo {
  root: string;
  name: string;
}

export type SessionStatus = "running" | "waiting" | "done" | "error";
/** Kanban column; you move sessions between them, agents never do. */
export type Stage = "inbox" | "planning" | "implementing" | "validating" | "complete";

export interface SessionInfo {
  id: string;
  name: string;
  agent: string;
  cwd: string;
  workspace: string;
  branch: string | null;
  worktree: string | null;
  status: SessionStatus;
  alive: boolean;
  exitCode: number | null;
  createdMs: number;
  updatedMs: number;
  /** Terminal title set by the agent (Claude Code: the conversation topic). */
  title: string | null;
  /** Explicitly renamed: the name wins over the title. */
  renamed: boolean;
  stage: Stage;
  /** Label color, one of `SESSION_COLORS`; absent from older daemons. */
  color?: string | null;
  /** Put away: out of tabs, lists and the board. */
  archived?: boolean;
}

/** Session label colors (`core::session::COLORS`), drawn from the theme's palette. */
export const SESSION_COLORS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "gray"];

export type ChangeKind = "added" | "modified" | "deleted";

export interface SessionChange {
  /** Relative to `SessionChanges.root`; what `sessionFileDiff` takes. */
  path: string;
  kind: ChangeKind;
  /** The same file in the workspace, when it is inside it. */
  wsPath: string | null;
}

export interface SessionChanges {
  root: string;
  base: string | null;
  files: SessionChange[];
}

export interface Commit {
  hash: string;
  short: string;
  author: string;
  timeMs: number;
  subject: string;
  /** The file's repo-relative path in that commit (renames are followed). */
  path: string;
}

export interface FileDiff {
  old: string | null;
  new: string | null;
}

export interface WorktreeStatus {
  path: string;
  /** Empty when HEAD is detached. */
  branch: string;
  /** The repository's own checkout. */
  main: boolean;
  /** Files with uncommitted or untracked changes; null when its folder is gone. */
  changed: number | null;
}

export interface NewSession {
  agent: string;
  name?: string;
  worktree?: string;
  args?: string[];
  cols: number;
  rows: number;
}

export interface CoreError {
  kind: string;
  message: string;
  /** The variable part of the message (a path, a name), for translation. */
  detail?: string;
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const err = e as CoreError;
    return errorText(err.kind, err.detail) ?? String(err.message);
  }
  return String(e);
}

export function errorKind(e: unknown): string | undefined {
  return e && typeof e === "object" && "kind" in e ? String((e as CoreError).kind) : undefined;
}

export const core = {
  initialPath: () => invoke<string | null>("initial_path"),
  openWorkspace: (path: string) => invoke<WorkspaceInfo>("open_workspace", { path }),
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  readFile: (path: string) => invoke<FileContent>("read_file", { path }),
  writeFile: (path: string, content: string) => invoke<FileStat>("write_file", { path, content }),
  statFile: (path: string) => invoke<FileStat>("stat_file", { path }),
  /** An empty file; missing folders are created, an existing file is refused. */
  createFile: (path: string) => invoke<FileStat>("create_file", { path }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  /** Renames or moves a file or folder; an existing target is refused. */
  renamePath: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  /** In the system's default app for the file. */
  openPath: (path: string) => invoke<void>("open_path", { path }),
  /** In Finder / Explorer / the file manager. */
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  /** To the system trash, where it can be restored. */
  trashPath: (path: string) => invoke<void>("trash_path", { path }),
  fileHistory: (path: string) => invoke<Commit[]>("file_history", { path }),
  commitDiff: (hash: string, path: string) => invoke<FileDiff>("commit_diff", { hash, path }),
  /** The file's page on the repository's web host. */
  shareLink: (path: string) => invoke<string>("share_link", { path }),
  /** Every worktree of the workspace's repository, main checkout first, with changed-file counts. */
  worktrees: () => invoke<WorktreeStatus[]>("worktrees"),
  /** A workspace image as a `data:` URL; null if the file is not an image. */
  readImage: (path: string) => invoke<string | null>("read_image", { path }),
  /** Opens an http(s) or mailto link in the system's handler. */
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  fuzzyFind: (query: string, limit = 50) => invoke<FuzzyMatch[]>("fuzzy_find", { query, limit }),
  searchText: (query: string, options: SearchOptions) =>
    invoke<SearchResults>("search_text", { query, options }),
  cancelSearch: () => invoke<void>("cancel_search"),
  quit: () => invoke<void>("quit"),
  onFsChange: (cb: (b: FsBatch) => void): Promise<UnlistenFn> =>
    listen<FsBatch>("fs-change", (e) => cb(e.payload)),

  sessionList: () => invoke<SessionInfo[]>("session_list"),
  sessionCreate: (req: NewSession) => invoke<SessionInfo>("session_create", { req }),
  /** Output arrives on `onOutput` as raw bytes, scrollback first. */
  sessionAttach: (id: string, onOutput: Channel<ArrayBuffer>) => invoke<void>("session_attach", { id, onOutput }),
  sessionDetach: (id: string) => invoke<void>("session_detach", { id }),
  sessionInput: (id: string, data: string) => invoke<void>("session_input", { id, data }),
  sessionResize: (id: string, cols: number, rows: number) => invoke<void>("session_resize", { id, cols, rows }),
  sessionKill: (id: string) => invoke<void>("session_kill", { id }),
  sessionRename: (id: string, name: string) => invoke<SessionInfo>("session_rename", { id, name }),
  sessionSetStage: (id: string, stage: Stage) => invoke<SessionInfo>("session_set_stage", { id, stage }),
  sessionSetColor: (id: string, color: string | null) => invoke<SessionInfo>("session_set_color", { id, color }),
  sessionSetArchived: (id: string, archived: boolean) =>
    invoke<SessionInfo>("session_set_archived", { id, archived }),
  sessionWorktreeDirty: (id: string) => invoke<boolean>("session_worktree_dirty", { id }),
  sessionRemove: (id: string, removeWorktree: boolean, force: boolean) =>
    invoke<void>("session_remove", { id, removeWorktree, force }),
  sessionChanges: (id: string) => invoke<SessionChanges>("session_changes", { id }),
  sessionFileDiff: (id: string, path: string) => invoke<FileDiff>("session_file_diff", { id, path }),
  onSessionUpdate: (cb: (s: SessionInfo) => void): Promise<UnlistenFn> =>
    listen<SessionInfo>("session-update", (e) => cb(e.payload)),
  onSessionRemoved: (cb: (id: string) => void): Promise<UnlistenFn> =>
    listen<string>("session-removed", (e) => cb(e.payload)),
  onSessiondDown: (cb: () => void): Promise<UnlistenFn> => listen("sessiond-down", () => cb()),
};
