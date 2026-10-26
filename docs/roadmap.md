# Roadmap

Ideias de produto ainda não planejadas. O plano de construção por fases fica no artifact citado no `CLAUDE.md`.

## Terminal: remendos do xterm.js e alternativas

Os terminais rodam em xterm.js dentro do webview, com três remendos:

- **`xtermWebglDimFix`** (`ui/vite.config.ts`): o renderer WebGL pinta uma caixa opaca atrás de texto dim/itálico. É bug do addon, não do webview; um patch upstream no xterm.js eliminaria o remendo.
- **`fittedFontSize`** (`ui/src/lib/cells.ts`): o xterm mede a fonte pelo DOM e arredonda a largura da célula para pixels de tela. É o único dos três ligado ao ambiente web, mas ainda é escolha do xterm.js.
- **Unicode 11** (`@xterm/addon-unicode11`): não é problema do webview. Qualquer terminal precisa de tabelas de largura que batam com as do agente (`string-width` no Claude Code).

### Caminhos

1. **Manter xterm.js e reduzir remendos** (atual, recomendado). Mandar o fix do dim upstream; quando sair numa versão, remover `xtermWebglDimFix`. Os outros dois são pequenos, isolados e testados.

2. **Estado do terminal em Rust, render na web.** Parser VT nativo (`alacritty_terminal`, `wezterm-term` ou `libghostty-vt`) no `sessiond`; a UI só desenha a grade num canvas próprio.
   - Ganha: parser de verdade, larguras definidas num só lugar, daemon guarda o estado da tela (reattach instantâneo, reflow correto, snapshots sem a UI aberta).
   - Custa: reescrever o que o xterm.js entrega (seleção, busca, links, IME, acessibilidade, renderer WebGL). Meses de trabalho.
   - Quando: só se surgirem limites reais (desempenho com scrollback grande, reattach lento) ou o terminal virar diferencial do produto.

3. **Terminal nativo sobreposto** (libghostty/Alacritty numa NSView sobre o webview). Descartado: a view nativa fica sempre acima do HTML, então perde paleta, menus e arrasto de abas sobre o terminal; perde transparência/blur coerentes; splits viram sincronização de coordenadas; foco e teclado divididos; libghostty embutível só está maduro no macOS, e o app mira Windows também.

