// Icons from Nerd Fonts (Codicons, VS Code's own set), drawn by a tiny font
// bundled with the app (`assets/icons/aurora-icons.woff`, its LICENSE.md says
// how to add one), so they show without a Nerd Font installed. The activity
// bar's are Font Awesome Free Solid, from a second subset (`aurora-activity.woff`).

/** Font Awesome glyphs, drawn with `.fa-icon`. */
const ACTIVITY = {
  "fa-house": "\u{F015}",
  "fa-folder-tree": "\u{F802}",
  "fa-terminal": "\u{F120}",
} as const;

const GLYPHS = {
  ...ACTIVITY,
  terminal: "\u{EA85}",
  board: "\u{EB30}",
  add: "\u{EA60}",
  // File tree header
  "new-file": "\u{EA7F}",
  "new-folder": "\u{EA80}",
  refresh: "\u{EB37}",
  "collapse-all": "\u{EAC5}",
  // File tree (lib/file-icons.ts)
  file: "\u{EA7B}",
  folder: "\u{EA83}",
  "folder-open": "\u{EAF7}",
  "file-code": "\u{EAE9}",
  "file-media": "\u{EAEA}",
  "file-pdf": "\u{EAEB}",
  "file-zip": "\u{EAEF}",
  "file-binary": "\u{EAE8}",
  markdown: "\u{EB1D}",
  json: "\u{EB0F}",
  settings: "\u{EB51}",
  book: "\u{EAA4}",
  lock: "\u{EA75}",
  database: "\u{EACE}",
  color: "\u{EB5C}",
  git: "\u{EA68}",
} as const;

export type IconName = keyof typeof GLYPHS;

export function Icon(p: { name: IconName; class?: string }) {
  const font = () => (p.name in ACTIVITY ? "fa-icon" : "nf-icon");
  return (
    <span class={`${font()} ${p.class ?? ""}`} aria-hidden="true">
      {GLYPHS[p.name]}
    </span>
  );
}
