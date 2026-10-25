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
- Done after Phase 2: session auto-title from OSC 0/2 (`sessiond/src/title.rs`, `displayName` in `ui/src/lib/sessions.ts`; `:session rename` pins a name), green-phosphor vim look (tokens, mode badge, hint bar, `:` opens the palette, Space leader), overlay titlebar, terminal cell-width fix (`fittedFontSize` in `ui/src/lib/cells.ts`). Base16/Base24 color schemes: `.yaml` files in `<data dir>/themes`, mapped to tokens in `core::theme`, picked with `:theme <id>` (`:theme dir` shows the folder). Built-in Ember scheme (`crates/core/themes/`, `accent:` key picks the UI accent). zn-style look on branch `ui-zn-look`: solid-accent tabs and selections (`--bg-pick`), titled boxes (`.box`/`.box-title`), one-line session rows, home screen (`components/Home.tsx`, `:home`, `Space h`) when no file is open, kanban of sessions by stage (`components/Kanban.tsx`, `:kanban`, `Space k`, `:session stage <stage>`; the stage lives in sessiond, `Request::SetStage`). Split editor: groups in `state/editor.ts` (one `EditorView` per group, a file in one group at a time) over the same `lib/panes.ts` layout as the terminals; `:split [right|down]`, `:sp`, `:only`, `⌘\` / `⌘⇧\`, `Space o` cycles panes; they act on whichever of editor and terminals was used last (`ui.workArea`). Terminal panes stack too (`Layout.dir`). Background opacity and blur in Preferences (`state/prefs.ts`): the window is transparent (`macOSPrivateApi`), large surfaces paint `--surface`/`--surface-panel`, which go transparent under `html.translucent`, and only `body` carries the tint (`--bg-alpha`).
- Next: Phase 3 — markdown read mode (comrak GFM in core), side-by-side preview with synced scroll, mermaid on demand, code highlight in markdown, per-session diff of the worktree, tree marks for files each session touched, keyboard-navigable links between `.md`. Consider using ZenNotes for the note-taking part and keeping Phase 3 to the agent-specific pieces (diff, tree marks).
- Then Phase 4 — `.excalidraw` viewer, sandboxed `.html` preview, native notification when a session waits, palette history/autocomplete, configurable keys/themes.

Ideas not started: warn when a session's folder has iCloud "dataless" files (agents hang on `git status` there); add `zn` to agent suggestions.

Gotchas:
- cargo needs `/opt/homebrew/opt/rustup/bin` on `PATH`.
- A stale `aurora-sessiond` keeps running old code after a rebuild: `pkill -f aurora-sessiond` (kills live sessions).
- Agent hooks call `<data dir>/bin/aurora-sessiond` (a copy the daemon refreshes at start, `session::stable_helper`), never the app bundle, so rebuilding or deleting the bundle doesn't break running sessions. Sessions started before that still point at the bundle path.
- xterm floors cell width to device pixels; keep the font nudged by `fittedFontSize` or the terminal looks squeezed.
