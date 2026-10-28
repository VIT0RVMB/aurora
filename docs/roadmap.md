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

## Visual moderno (IDE + notas)

Branch `ui-modern`. Referência Obsidian/Linear, fonte do sistema na interface, accent azul, dois temas (claro/escuro, com `system` seguindo o SO).

Feito:

1. **Temas**: só `system`/`dark`/`light` em `tokens.css`; Base16/Base24 e `core::theme` removidos.
2. **Grade de células fora do chrome**: interface em fonte do sistema e escala `--sp-*`; células só no código, terminal e larguras de painel (`--cell-w` medido da fonte mono).
3. **Componentes**: painéis sem moldura, cards na home/quadro/diff/histórico, abas em pílula, chevrons desenhados em CSS na árvore, switches nas Preferências, menus e paleta com sombra e cantos arredondados. Vim desligado por padrão; badge de modo e barra de dicas só com vim.
4. **Markdown como notas**: no modo rico, texto proporcional alinhado à esquerda (até 760px de largura), sem gutter; código, blocos e fonte de tabela continuam mono.

Próximos passos:

- Ícones de arquivo/pasta na árvore e checkboxes de tarefa renderizados de verdade no markdown.
- Mermaid com a fonte da interface.
- Tela de boas-vindas (sem pasta aberta) revisada no app real.
- Conferir translucidez/blur no app real (os screenshots são do mock no Chrome).

## Visual denso (IDE)

Branch `ui-dense`, derivada de `ui-modern`. Referência Visual Studio / VS Code em vez de Obsidian: mesma estrutura, mais informação por tela.

Feito (só tokens e CSS, nenhum componente mudou):

1. **Cores**: paletas Dark Modern / Light Modern do VS Code, sintaxe e ANSI do VS Code.
2. **Densidade**: interface em 12px, linhas de lista com 22px, barra de título com 30px, abas com 35px, cantos quase retos.
3. **Árvore e markdown**: ícones de arquivo e pasta (Codicons) coloridos por tipo; o markdown rico usa toda a largura do editor.
4. **Componentes**: abas retangulares separadas por linhas (a ativa se funde ao editor e ganha linha de accent em cima quando o painel tem foco), cabeçalhos de seção em caixa alta, abas do painel direito sublinhadas, barra de status azul, activity bar com marca na borda esquerda, linha focada de listas emoldurada no accent, linha atual do código emoldurada.

Próximos passos:

- Comparar lado a lado com `ui-modern` no app real e escolher (ou expor como preferência de densidade).
- Ícones por tipo de arquivo também nas abas (na árvore já estão: Codicons coloridos por tipo, `lib/file-icons.ts`).
