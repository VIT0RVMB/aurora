# aurora-icons.woff

A subset of **Symbols Nerd Font Mono** (Nerd Fonts v3.5.1,
https://github.com/ryanoasis/nerd-fonts), holding only the glyphs Aurora uses:
`cod-home` (U+EB06), `cod-terminal` (U+EA85), `cod-project` (U+EB30), `cod-add` (U+EA60),
`md-file_tree` (U+F0645), and for the file tree
`cod-file` (U+EA7B), `cod-folder` (U+EA83), `cod-folder_opened` (U+EAF7), `cod-file_code` (U+EAE9),
`cod-file_media` (U+EAEA), `cod-file_pdf` (U+EAEB), `cod-file_zip` (U+EAEF),
`cod-file_binary` (U+EAE8), `cod-markdown` (U+EB1D), `cod-json` (U+EB0F),
`cod-settings_gear` (U+EB51), `cod-book` (U+EAA4), `cod-lock` (U+EA75),
`cod-database` (U+EACE), `cod-symbol_color` (U+EB5C) and `cod-source_control` (U+EA68), and for
the tree's header `cod-new_file` (U+EA7F), `cod-new_folder` (U+EA80), `cod-refresh` (U+EB37) and
`cod-collapse_all` (U+EAC5).

- The `cod-*` glyphs are Microsoft's **Codicons** (https://github.com/microsoft/vscode-codicons),
  licensed under **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/).
- `md-file_tree` is from **Material Design Icons** (https://github.com/Templarian/MaterialDesign-Font),
  licensed under **Apache 2.0** (https://www.apache.org/licenses/LICENSE-2.0).
- The Nerd Fonts patching and packaging is MIT licensed, © 2014 Ryan L McIntyre.

Regenerate (add a codepoint to `--unicodes` for a new icon):

```sh
pyftsubset SymbolsNerdFontMono-Regular.ttf --flavor=woff --layout-features='' --no-hinting \
  --unicodes="U+EB06,U+F0645,U+EA85,U+EB30,U+EA60,U+EA7B,U+EA83,U+EAF7,U+EAE9,U+EAEA,U+EAEB,U+EAEF,U+EB1D,U+EB0F,U+EB51,U+EAA4,U+EA75,U+EAE8,U+EACE,U+EB5C,U+EA68,U+EA7F,U+EA80,U+EB37,U+EAC5" \
  --output-file=aurora-icons.woff
```
