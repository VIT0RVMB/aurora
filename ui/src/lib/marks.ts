// Tree marks: which workspace files (and folders) sessions have changed.
import type { ChangeKind, SessionChange } from "./ipc";
import { parentPath } from "./tree";

export interface Mark {
  kind: ChangeKind;
  /** Sessions that changed it, by display name. */
  sessions: string[];
}

export interface Marks {
  files: Map<string, Mark>;
  /** Folders holding a marked file, with the sessions behind them. */
  dirs: Map<string, string[]>;
}

export const MARK_GLYPH: Record<ChangeKind, string> = { added: "+", modified: "~", deleted: "−" };

export function buildMarks(list: { name: string; files: SessionChange[] }[]): Marks {
  const files = new Map<string, Mark>();
  const dirs = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, name: string) => {
    const names = map.get(key);
    if (!names) map.set(key, [name]);
    else if (!names.includes(name)) names.push(name);
  };
  for (const { name, files: changed } of list) {
    for (const f of changed) {
      if (f.wsPath == null) continue;
      const mark = files.get(f.wsPath);
      if (!mark) files.set(f.wsPath, { kind: f.kind, sessions: [name] });
      else if (!mark.sessions.includes(name)) mark.sessions.push(name);
      for (let d = parentPath(f.wsPath); d; d = parentPath(d)) add(dirs, d, name);
    }
  }
  return { files, dirs };
}
