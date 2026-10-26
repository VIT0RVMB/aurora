# Aurora

**A lightweight, vim-terminal-styled IDE for running and keeping track of many coding agents at once.**

Claude Code, Codex and other agents already write a good share of the code. The bottleneck now is managing their work: five sessions in five terminal tabs, with no way to tell which one finished, which one is waiting for your answer and which one is stuck. Closing the terminal kills them all. And traditional IDEs are heavy and built for you to type code, not to review what agents did.

Aurora brings together, in a single window:

- **agent sessions** that stay alive even when the app is closed;
- **the state of each one** (running, waiting for you, done, error), reported by the agent's own hooks rather than guessed;
- **an editor and a file tree** to read and adjust what they wrote;
- **one git worktree per session**, so agents working in parallel don't step on each other.

All keyboard-driven, vim style.

## Value proposition

| Problem | How Aurora solves it |
| --- | --- |
| Closing the terminal or the app kills the agent | A daemon (`aurora-sessiond`) owns the PTYs. The app connects and disconnects; the session and its history stay there. |
| You can't tell which agent needs you | Claude Code hooks and an opencode plugin notify the daemon; other agents report running or exited from the process. Sessions waiting for you are listed first and highlighted. |
| Several agents in the same repository get in each other's way | `:session new claude --worktree fix-login` creates an isolated worktree and branch for the session. |
| Tabs with generic names ("claude", "claude (2)") | Each session is named after the conversation topic, like in Ghostty. `:session rename` pins any name you want. |
| IDEs are heavy and slow to open | Tauri + Rust: an app of a few MB that opens instantly and never loads the contents of every file. |
| You live in the terminal and in vim | Optional vim modes, `:` for commands and Space as leader. |

## Features

**Agent sessions**
- `claude`, `codex`, `opencode`, `agy` (Antigravity) or a plain `shell`, in tabs and splits.
- Close and reopen the app, and the history (scrollback) comes back.
- States from hooks: running, waiting for you, done and error.
- Optional git worktree per session. Removal asks for confirmation when the worktree has uncommitted changes.
- Automatic title from the session topic.

**Editor and navigation**
- CodeMirror 6 with vim mode (`:w`, `:q`, `:wq`, `:%s/a/b/g`…).
- File tree, fuzzy file search and project-wide text search.
- Command palette (`:`) and themes.

## Main shortcuts

| Action | Shortcut | Leader (Space) |
| --- | --- | --- |
| Open file (fuzzy) | `Cmd+P` | `Space f` |
| Command palette | `Cmd+Shift+P` or `:` | `Space p` |
| Search the project | `Cmd+Shift+F` | `Space /` |
| Sessions panel | `Cmd+Shift+A` | `Space s` |
| New session | — | `Space n` |
| Show/hide terminals | `Cmd+J` | `Space t` |
| Split the pane | `Cmd+\` | — |
| File tree | `Cmd+B` / `Cmd+Shift+E` | `Space b` / `Space e` |
| Save / close | `Cmd+S` / `Cmd+W` | `Space w` / `Space q` |

On Linux and Windows, use `Ctrl` instead of `Cmd`. Inside a terminal, `Ctrl+letter` belongs to the shell, so app shortcuts there need `Shift`.

## Session commands

```
:session new claude                       new Claude Code session in the open folder
:session new codex --worktree fix-login   Codex session in its own worktree/branch
:session new claude -n api -- --model opus
:session rename <new-name>
:session focus <session>
:session kill [session]
:session rm [session]                     stops and removes it (and the worktree, after confirmation)
:split / :unsplit
```

## Architecture

```
┌──────────────── App (Tauri) ────────────────┐       ┌──── aurora-sessiond ────┐
│ ui/  Solid + CodeMirror 6 + xterm.js        │       │ owns the PTYs           │
│      rendering only                         │       │ history (2 MiB ring)    │
│ crates/app  thin Tauri commands             │◄─────►│ SQLite metadata         │
│ crates/core all logic: files, index,        │socket │ title from OSC 0/2      │
│             search, git, session client     │ local └───────────▲─────────────┘
└─────────────────────────────────────────────┘                   │ aurora-sessiond notify
                                                       Claude hooks / opencode plugin
```

- **`crates/core`**: all the logic, no Tauri dependency, testable on its own.
- **`crates/sessiond`**: a daemon that outlives the app. Talks over a Unix socket (macOS/Linux) or a named pipe (Windows).
- **`crates/app`**: the Tauri shell, only `#[tauri::command]` wrappers.
- **`ui/`**: Solid + TypeScript. Never reads files or runs processes; everything goes through the core.

Lightness is a product requirement: every new dependency needs a justification.

## Running

Requirements: Rust (2024 edition), Node and pnpm, and `git` on the PATH. For agent sessions, the agent's CLI installed (`claude`, `codex`…).

```sh
pnpm install
pnpm dev                        # run the app
pnpm dev -- -- ~/my-project     # open a folder directly
pnpm build                      # build the .app/.dmg with sessiond bundled
```

Tests:

```sh
cargo test
cargo clippy --workspace --all-targets
pnpm test
pnpm typecheck
```

Data (socket, `sessions.db`, history, `sessiond.log`) lives in `~/Library/Application Support/dev.aurora.ide` on macOS. The `AURORA_DATA_DIR` variable changes the location.

## Roadmap

- [x] **Phase 1**: editor, tree, fuzzy search, project search and themes.
- [x] **Phase 2**: session daemon, reconnect with history, worktrees, hook-driven states, tabs and splits.
- [ ] **Phase 3**: rich markdown (GFM preview, mermaid, links between notes), per-session diff, and tree marks for the files each agent touched.
- [ ] **Phase 4**: `.excalidraw` viewer, sandboxed `.html` preview, native notification when a session is waiting for you, configurable shortcuts and themes.

## Status

In active development (v0.1.0). Tested mainly on macOS (Apple Silicon).
