// Which icon and color a tree entry gets, from its name alone (no file reads).
// Glyphs are Codicons from the bundled icon font (components/Icon.tsx); the
// tone is a CSS class (`ft-<tone>`) whose color comes from an `--icon-*` token.

import type { IconName } from "../components/Icon";

export type Tone = "folder" | "code" | "doc" | "data" | "style" | "media" | "config" | "faint" | "plain";

export interface FileIcon {
  icon: IconName;
  tone: Tone;
}

const BY_EXT: Record<string, FileIcon> = {};
function add(exts: string, icon: IconName, tone: Tone) {
  for (const e of exts.split(" ")) BY_EXT[e] = { icon, tone };
}
add("rs ts tsx js jsx mjs cjs mts cts py go c h cc cpp hpp java kt swift rb php cs lua zig vue svelte ex exs hs ml", "file-code", "code");
add("sh bash zsh fish ps1", "terminal", "code");
add("md mdx markdown", "markdown", "doc");
add("txt rst adoc org", "file", "doc");
add("json jsonc json5", "json", "data");
add("csv tsv xml", "file-code", "data");
add("sql db sqlite", "database", "data");
add("yaml yml toml ini conf cfg env", "settings", "config");
add("lock", "lock", "config");
add("css scss sass less", "color", "style");
add("html htm", "file-code", "style");
add("png jpg jpeg gif webp ico bmp svg avif mp4 mov webm mp3 wav ogg woff woff2 ttf otf excalidraw", "file-media", "media");
add("pdf", "file-pdf", "media");
add("zip tar gz tgz bz2 xz 7z rar", "file-zip", "faint");
add("exe bin wasm dylib so dll o a", "file-binary", "faint");

const BY_NAME: Record<string, FileIcon> = {
  ".gitignore": { icon: "git", tone: "config" },
  ".gitattributes": { icon: "git", tone: "config" },
  ".gitmodules": { icon: "git", tone: "config" },
  "package-lock.json": { icon: "lock", tone: "config" },
  "pnpm-lock.yaml": { icon: "lock", tone: "config" },
  dockerfile: { icon: "settings", tone: "config" },
  makefile: { icon: "settings", tone: "config" },
  ".editorconfig": { icon: "settings", tone: "config" },
};

export function fileIcon(name: string, isDir: boolean, open = false): FileIcon {
  if (isDir) return { icon: open ? "folder-open" : "folder", tone: "folder" };
  const lower = name.toLowerCase();
  const exact = BY_NAME[lower];
  if (exact) return exact;
  if (/^(readme|license|licence|changelog|contributing)(\.|$)/.test(lower)) return { icon: "book", tone: "doc" };
  if (lower.startsWith(".env")) return { icon: "settings", tone: "config" };
  const dot = lower.lastIndexOf(".");
  return (dot > 0 && BY_EXT[lower.slice(dot + 1)]) || { icon: "file", tone: "plain" };
}
