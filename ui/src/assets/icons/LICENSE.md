# aurora-icons.woff

A subset of **Symbols Nerd Font Mono** (Nerd Fonts v3.5.1,
https://github.com/ryanoasis/nerd-fonts), holding only the glyphs Aurora uses:
`cod-home` (U+EB06), `cod-terminal` (U+EA85), `cod-project` (U+EB30),
`cod-add` (U+EA60) and `md-file_tree` (U+F0645).

- The `cod-*` glyphs are Microsoft's **Codicons** (https://github.com/microsoft/vscode-codicons),
  licensed under **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/).
- `md-file_tree` is from **Material Design Icons** (https://github.com/Templarian/MaterialDesign-Font),
  licensed under **Apache 2.0** (https://www.apache.org/licenses/LICENSE-2.0).
- The Nerd Fonts patching and packaging is MIT licensed, © 2014 Ryan L McIntyre.

Regenerate (add a codepoint to `--unicodes` for a new icon):

```sh
pyftsubset SymbolsNerdFontMono-Regular.ttf --flavor=woff --layout-features='' --no-hinting \
  --unicodes="U+EB06,U+F0645,U+EA85,U+EB30,U+EA60" --output-file=aurora-icons.woff
```
