import type { DirEntry } from "./ipc";

export interface TreeRow {
  entry: DirEntry;
  depth: number;
  expanded: boolean;
  /** Directory is expanded but its children have not arrived yet. */
  loading: boolean;
}

/**
 * Flattens the loaded part of the tree into visible rows, depth-first.
 * `children` maps a directory path ("" = root) to its listing.
 */
export function flattenTree(
  children: Record<string, DirEntry[] | undefined>,
  expanded: ReadonlySet<string>,
  dir = "",
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (path: string, depth: number) => {
    for (const entry of children[path] ?? []) {
      const open = entry.isDir && expanded.has(entry.path);
      rows.push({ entry, depth, expanded: open, loading: open && !children[entry.path] });
      if (open) walk(entry.path, depth + 1);
    }
  };
  walk(dir, 0);
  return rows;
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Every ancestor directory of `path`, outermost first ("a/b/c.rs" → ["a", "a/b"]). */
export function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
