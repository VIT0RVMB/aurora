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
