// Icons from Nerd Fonts (Codicons, VS Code's own set, plus one Material Design glyph), drawn by a tiny font
// bundled with the app (`assets/icons/aurora-icons.woff`, its LICENSE.md says
// how to add one), so they show without a Nerd Font installed.

const GLYPHS = {
  home: "\u{EB06}",
  files: "\u{F0645}", // md-file_tree
  terminal: "\u{EA85}",
  board: "\u{EB30}",
  add: "\u{EA60}",
} as const;

export type IconName = keyof typeof GLYPHS;

export function Icon(p: { name: IconName; class?: string }) {
  return (
    <span class={`nf-icon ${p.class ?? ""}`} aria-hidden="true">
      {GLYPHS[p.name]}
    </span>
  );
}
