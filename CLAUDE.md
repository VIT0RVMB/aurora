# Aurora

Lightweight, terminal-styled IDE for running coding agents. Tauri 2 + Rust core + Solid UI.

## Layout

- `crates/core` — all logic (files, tree, fuzzy index, search, watcher, git, session protocol/client). No Tauri dependency; testable alone.
- `crates/sessiond` — `aurora-sessiond`, the daemon that owns every agent PTY so sessions survive the app. Also `notify` (called by agent hooks) and `dump-env`. Talks to clients over a Unix socket / named pipe (`core::session::transport`).
- `crates/app` — Tauri shell. Only thin `#[tauri::command]` wrappers (`src/commands.rs`, `src/sessions.rs`).
- `ui/` — Solid + TypeScript + CodeMirror 6. Renders; never reads files or runs processes.

## Rules

- New logic goes in `crates/core`, never in Tauri commands or the UI.
- The UI does not read files or run processes; everything goes through a core command (`ui/src/lib/ipc.ts`).
- Never load the contents of every file; the tree and index use metadata only.
- Paths crossing the IPC boundary are workspace-relative with `/` separators.
- A new dependency needs a justification in the PR: weight is a product requirement.
- Session status comes from agent hooks calling `aurora-sessiond notify`, never from parsing terminal output.
- Off macOS, Ctrl+letter inside a terminal belongs to the shell; app shortcuts there need Shift.
- User-facing text goes through `t()` in `ui/src/lib/i18n.ts`, with both `en` (default) and `pt-BR` entries. Core error messages are English; the UI translates them by `kind` + `detail`.
- Colors come from tokens in `ui/src/styles/tokens.css`; sizes are in cells (`var(--cell-w)`, `var(--cell-h)`).
- No `git push`, `reset` or `stash` without asking.

## Commands

- `pnpm install` then `pnpm dev` — run the app (`pnpm dev -- -- <folder>` opens a folder).
- `cargo test`, `cargo clippy --workspace --all-targets`
- `pnpm test`, `pnpm typecheck`
- Perf check: `cargo test -p aurora-core --release --test perf -- --ignored --nocapture`
- Real Claude hooks (spends tokens): `cargo test -p aurora-sessiond --test daemon real_claude -- --ignored --nocapture`
- In-app smoke test (run twice: create, then reattach): `AURORA_SMOKE=1 pnpm dev -- -- "$PWD"`
- `pnpm build` bundles `aurora-sessiond` as a sidecar (`scripts/sessiond.mjs` + `crates/app/tauri.bundle.json`).
- Data (socket, `sessions.db`, history, `sessiond.log`): `~/Library/Application Support/dev.aurora.ide` on macOS; `AURORA_DATA_DIR` overrides.

## Status (resume here)

Build plan: "IDE de Agentes — Plano de Construção" (https://claude.ai/artifact/39hJEaMDgAsrSPF7s8qv3F). Each slice ends with tests/evidence; the user reviews and commits.

- Phase 1 (editor, tree, fuzzy open, search, themes) — done.
- Phase 2 (sessiond, PTY sessions, reattach with scrollback, worktrees, hooks, panes/tabs/splits) — done. Acceptance (5 agents, app closed and reopened, history back) is covered by `crates/sessiond/tests/daemon.rs` and the smoke test.
- Done after Phase 2: session auto-title from OSC 0/2 (`sessiond/src/title.rs`, `displayName` in `ui/src/lib/sessions.ts`; `:session rename` pins a name), green-phosphor vim look (tokens, mode badge, hint bar, `:` opens the palette, Space leader), overlay titlebar, terminal cell-width fix (`fittedFontSize` in `ui/src/lib/cells.ts`). Base16/Base24 color schemes: `.yaml` files in `<data dir>/themes`, mapped to tokens in `core::theme`, picked with `:theme <id>` (`:theme dir` shows the folder). Built-in Ember scheme (`crates/core/themes/`, `accent:` key picks the UI accent). zn-style look on branch `ui-zn-look`: solid-accent tabs and selections (`--bg-pick`), titled boxes (`.box`/`.box-title`), one-line session rows, home screen (`components/Home.tsx`, `:home`, `Space h`) when no file is open, kanban of sessions by stage (`components/Kanban.tsx`, `:kanban`, `Space k`, `:session stage <stage>`; the stage lives in sessiond, `Request::SetStage`). Split editor: groups in `state/editor.ts` (one `EditorView` per group, a file in one group at a time) over the same `lib/panes.ts` layout as the terminals; `:split [right|down]`, `:sp`, `:only`, `⌘\` / `⌘⇧\`, `Space o` cycles panes; they act on whichever of editor and terminals was used last (`ui.workArea`). Terminal panes stack too. Panes form a split tree (`Layout.tree` in `lib/panes.ts`, VS Code-style nesting; `Layout.panes` stays the flat list of leaves in reading order, and layouts saved with the old `dir` still load). `components/SplitArea.tsx` places panes absolutely from the tree so editors and xterms are never remounted, with draggable dividers (`panes.resize`). Tabs drag between panes (`state/drag.ts`, pointer events, not HTML5 DnD): onto a tab strip slot, a pane's middle, or an edge to split it; editor tabs only into editor groups, sessions only into terminal panes; Esc cancels. The whole terminal area docks on any side of the editor (`ui.dock`, `:dock [bottom|right|left|top]`, or drop a session tab on an editor edge); `Center` in `App.tsx` only changes grid placement, never DOM order, so nothing remounts. Background opacity and blur in Preferences (`state/prefs.ts`): the window is transparent (`macOSPrivateApi`), large surfaces paint `--surface`/`--surface-panel`, which go transparent under `html.translucent`, and only `body` carries the tint (`--bg-alpha`).
- Phase 2 gaps closed: opencode status through a plugin in `<data dir>/agents/opencode` passed as `OPENCODE_CONFIG_DIR` (`agents::opencode_plugin`; a folder the user already set wins and that session has no status hooks); Windows daemon test in `crates/sessiond/tests/windows.rs` (runs in CI only). Gemini CLI has hooks but only through settings files; not wired. Codex runs without hooks (status from the process): any `-c` override drops it out of its shared background server with a startup warning.
- Phase 3 (markdown and review), done:
  - Rich markdown instead of the planned comrak read mode and side-by-side preview (decided with the user): `lib/markdown-rich.ts` decorates CodeMirror in place, Obsidian-style. Markup hides except on lines the selection touches; tasks, bullets, tables, mermaid (lazy chunk, `securityLevel: "strict"`), images (`core.readImage`, `data:` URLs) and code labels render. A vertical step lands inside a rendered block instead of hopping over it (`enterBlocks`). Tables stay rendered under the cursor and are edited cell by cell (`lib/markdown-table.ts`: each keystroke rewrites only the changed part of that cell's source; Tab/Enter/arrows move, Enter on the last row adds one, Esc or an arrow past the edge returns to the editor; `‹›` shows one table's source). Vim keys don't apply inside a cell, and the Space leader only fires with the editor text focused. The flag is a remembered preference like vim: `:rich`, Preferences › editor. Code in fenced blocks is highlighted by the same lezer parsers as the editor (GFM via `markdownSupport`).
  - Links: `[x](y.md#h)` and `[[name#h|alias]]` follow on click (rendered), ⌘-click, ⌘Enter or vim `gf` (`lib/links.ts`; wiki names go through the fuzzy index; http/mailto open outside via `core::open`, nothing else).
  - Per-session diff: `core::session::changes` (worktree: git against the merge-base with the workspace HEAD; in-place session: files its hooks reported writing, kept while git still shows them changed). Hooks report files through `notify --stdin` (Claude `PostToolUse` payload) or `--file` (opencode `file.edited`); sessiond stores them (`touched` table, `Request::Touched`). `:diff [session]`, `:session diff`, `Space d`, `d` on the kanban: `components/Diff.tsx` (`@codemirror/merge`, side by side, unchanged runs collapsed).
  - Tree marks from the same data (`state/changes.ts`, `lib/marks.ts`): `+ ~ −` on files, `•` on folders; the tooltip names the sessions.
- Right-click menus (`components/ContextMenu.tsx`, actions in `state/menus.ts`; `ui.ask` is the one-line prompt): tree rows offer new file, view history (`:history`, `components/History.tsx` over `git::file_history`, renames followed), open in default app and show in Finder (`core::open`), copy path / relative path, share link (`git::share_link`: the branch if pushed upstream, else the commit), rename (`Workspace::create_file` / `rename`, never overwriting; open tabs follow through `editor.renamePath`) and delete (to the system trash via the `trash` crate, after a confirmation; its only new crates are `trash` and `urlencoding`); sessions (terminal tab, sessions panel, kanban card, home) offer rename, label color, show changes, archive and remove. Color and archive live in sessiond like the stage (`SessionInfo.color` from `session::COLORS`, drawn from the theme's ANSI palette via `--sc-*`; `SessionInfo.archived`). Archived sessions leave tabs, lists, the board and the marks (`sessions.here()`) and keep running if alive; the sessions panel header switches between active and archived; `:session color|archive|unarchive`.
- Home's Worktrees card lists every worktree of the repository (`git::worktree_statuses`, main checkout first) with its changed-file count from `git status`, so manual edits count too; it names the sessions using each (or `manual`) and recounts on session activity, workspace file changes and window focus.
- Activity bar left of the tree (`components/ActivityBar.tsx`): home, files (the open files, else home), sessions. Icons are Nerd Fonts glyphs (Codicons, plus `md-file_tree` for files), bundled as a 1.5 KB subset font (`ui/src/assets/icons/aurora-icons.woff`, `components/Icon.tsx`; `LICENSE.md` there has the attribution and the `pyftsubset` line to add a glyph). `ui.mode` is `work` (editor or a view, terminals docked) or `sessions` (terminals alone, with a bar whose board toggle puts the kanban beside them on the dock's side). Opening a file, the diff or history returns to `work`.
- Next: Phase 4 — `.excalidraw` viewer, sandboxed `.html` preview, native notification when a session waits, palette history/autocomplete, configurable keys/themes.

Ideas not started: warn when a session's folder has iCloud "dataless" files (agents hang on `git status` there); add `zn` to agent suggestions.

Gotchas:
- cargo needs `/opt/homebrew/opt/rustup/bin` on `PATH`.
- A stale `aurora-sessiond` keeps running old code after a rebuild: `pkill -f aurora-sessiond` (kills live sessions).
- Agent hooks call `<data dir>/bin/aurora-sessiond` (a copy the daemon refreshes at start, `session::stable_helper`), never the app bundle, so rebuilding or deleting the bundle doesn't break running sessions. Sessions started before that still point at the bundle path.
- xterm floors cell width to device pixels; keep the font nudged by `fittedFontSize` or the terminal looks squeezed.
- Terminals use Unicode 11 widths (`@xterm/addon-unicode11`, needs `allowProposedApi`): with xterm's default Unicode 6 tables emoji count as one cell and agents' status lines draw over them. Not the graphemes addon: it is experimental, and a terminal whose widths differ from the app's (`string-width` in Claude Code) breaks cursor positioning. Wheel scroll speed is a preference (`prefs.termScroll`, default 3 lines).
