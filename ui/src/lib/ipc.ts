// Typed wrappers over the core's Tauri commands. The UI never touches the
// filesystem or processes directly; everything goes through here.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { errorText } from "./i18n";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
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
}

export interface NewSession {
  agent: string;
  name?: string;
  worktree?: string;
  args?: string[];
  cols: number;
  rows: number;
}

export type ThemeVariant = "dark" | "light";

export interface ThemeInfo {
  id: string;
  name: string;
  variant: ThemeVariant;
}

export interface ThemeList {
  /** Folder the schemes are read from. */
  dir: string;
  themes: ThemeInfo[];
}

export interface ThemeTokens extends ThemeInfo {
  /** CSS custom property (plus `color-scheme`) to value. */
  tokens: Record<string, string>;
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
  fuzzyFind: (query: string, limit = 50) => invoke<FuzzyMatch[]>("fuzzy_find", { query, limit }),
  searchText: (query: string, options: SearchOptions) =>
    invoke<SearchResults>("search_text", { query, options }),
  cancelSearch: () => invoke<void>("cancel_search"),
  quit: () => invoke<void>("quit"),
  listThemes: () => invoke<ThemeList>("list_themes"),
  loadTheme: (id: string) => invoke<ThemeTokens>("load_theme", { id }),
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
  sessionWorktreeDirty: (id: string) => invoke<boolean>("session_worktree_dirty", { id }),
  sessionRemove: (id: string, removeWorktree: boolean, force: boolean) =>
    invoke<void>("session_remove", { id, removeWorktree, force }),
  onSessionUpdate: (cb: (s: SessionInfo) => void): Promise<UnlistenFn> =>
    listen<SessionInfo>("session-update", (e) => cb(e.payload)),
  onSessionRemoved: (cb: (id: string) => void): Promise<UnlistenFn> =>
    listen<string>("session-removed", (e) => cb(e.payload)),
  onSessiondDown: (cb: () => void): Promise<UnlistenFn> => listen("sessiond-down", () => cb()),
};
