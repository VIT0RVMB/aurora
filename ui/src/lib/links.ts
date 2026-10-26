// Where a markdown link points, decided without touching the disk. Paths are
// workspace-relative with `/`, like everything else crossing the IPC boundary.
import { parentPath } from "./tree";

export type LinkTarget =
  | { kind: "external"; url: string }
  /** A heading in the same file. */
  | { kind: "anchor"; anchor: string }
  | { kind: "file"; path: string; anchor: string | null }
  /** `[[name]]`: found by file name, wherever it lives. */
  | { kind: "wiki"; name: string; anchor: string | null };

const EXTERNAL = /^(https?:|mailto:)/i;

/** Joins `rel` onto folder `dir`, folding `.` and `..`; null if it climbs out of the workspace. */
export function joinPath(dir: string, rel: string): string | null {
  const out = rel.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const part of rel.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

function splitAnchor(s: string): [string, string | null] {
  const i = s.indexOf("#");
  return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1) || null];
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A `[text](href)` link found in the file at `from`. */
export function resolveHref(from: string, href: string): LinkTarget | null {
  const h = href.trim().replace(/^<|>$/g, "");
  if (!h) return null;
  if (EXTERNAL.test(h)) return { kind: "external", url: h };
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null; // other schemes: not ours to open
  const [file, anchor] = splitAnchor(h);
  if (!file) return anchor ? { kind: "anchor", anchor: decode(anchor) } : null;
  const path = joinPath(parentPath(from), decode(file));
  return path ? { kind: "file", path, anchor: anchor && decode(anchor) } : null;
}

/** The inside of `[[...]]`: `name`, `name#heading`, `name|alias`. */
export function resolveWiki(inner: string): LinkTarget | null {
  const [target] = inner.split("|");
  const [name, anchor] = splitAnchor(target.trim());
  if (!name) return anchor ? { kind: "anchor", anchor } : null;
  return { kind: "wiki", name: name.trim(), anchor };
}

/** Picks the file a wiki name means among fuzzy candidates: exact path, then file name, `.md` optional. */
export function pickWiki(name: string, candidates: string[]): string | null {
  const want = name.toLowerCase().replace(/\.(md|markdown)$/, "");
  const stem = (p: string) => p.toLowerCase().replace(/\.(md|markdown)$/, "");
  const md = candidates.filter((p) => /\.(md|markdown)$/i.test(p));
  return md.find((p) => stem(p) === want) ?? md.find((p) => stem(p).endsWith(`/${want}`)) ?? null;
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to `-`. */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
