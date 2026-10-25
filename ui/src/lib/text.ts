export type Eol = "lf" | "crlf";

/** CRLF only when every line break in the file is CRLF; mixed files stay LF. */
export function detectEol(text: string): Eol {
  const crlf = text.split("\r\n").length - 1;
  if (crlf === 0) return "lf";
  const lf = text.split("\n").length - 1;
  return lf === crlf ? "crlf" : "lf";
}

/** Files above this size open without syntax highlighting to keep typing smooth. */
export const HIGHLIGHT_LIMIT_BYTES = 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Last two segments of a path (`…/aurora/ui`), for tight labels. */
export function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

/** Compact age, like a TUI column: `now`, `5m`, `3h`, `2d`, `6w`. */
export function ago(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 14 ? `${d}d` : `${Math.floor(d / 7)}w`;
}
