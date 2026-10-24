// Dev-only fake core so the UI can run in a plain browser (`pnpm --filter aurora-ui dev`)
// for quick visual checks. Never bundled in production builds.
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const files: Record<string, string> = {
  "README.md": "# aurora\n\nIDE leve com cara de terminal.\n\n- [x] árvore\n- [ ] sessões\n",
  "Cargo.toml": '[workspace]\nmembers = ["crates/core", "crates/app"]\n',
  "crates/core/src/lib.rs": "//! Aurora core\n\npub fn hello(name: &str) -> String {\n    format!(\"olá, {name}\")\n}\n",
  "crates/core/src/search.rs": "use std::path::Path;\n\n/// Busca texto.\npub fn search(root: &Path, query: &str) -> usize {\n    let _ = (root, query);\n    0\n}\n",
  "ui/src/App.tsx": 'export function App() {\n  return <div class="app">aurora</div>;\n}\n',
  "ui/src/main.tsx": 'import { render } from "solid-js/web";\nrender(() => <App />, document.body);\n',
};
for (let i = 0; i < 300; i++) files[`fixtures/many/file${String(i).padStart(3, "0")}.txt`] = `linha ${i}\n`;

// ~5 MB file to check that big buffers open without freezing the UI.
files["fixtures/big.rs"] = Array.from({ length: 90_000 }, (_, i) => `fn item_${i}() -> u64 { ${i} * 2 + 1 } // ${"x".repeat(20)}`).join("\n");

const mtimes: Record<string, number> = {};
const now = () => Date.now();

function listDir(dir: string) {
  const prefix = dir ? `${dir}/` : "";
  const seen = new Map<string, boolean>();
  for (const p of Object.keys(files)) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const i = rest.indexOf("/");
    seen.set(i === -1 ? rest : rest.slice(0, i), i !== -1);
  }
  return [...seen]
    .map(([name, isDir]) => ({ name, isDir, path: prefix + name }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

function fuzzy(query: string, limit: number) {
  const q = query.toLowerCase();
  const out = [];
  for (const path of Object.keys(files).sort()) {
    const indices: number[] = [];
    let j = 0;
    for (let i = 0; i < path.length && j < q.length; i++) if (path[i].toLowerCase() === q[j]) indices.push(i), j++;
    if (j === q.length) out.push({ path, score: 1000 - path.length, indices });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

function search(query: string) {
  const result = [];
  let total = 0;
  for (const path of Object.keys(files).sort()) {
    const lines = [];
    for (const [n, text] of files[path].split("\n").entries()) {
      const at = text.toLowerCase().indexOf(query.toLowerCase());
      if (query && at >= 0) lines.push({ line: n + 1, text, ranges: [[at, at + query.length]], column: at });
    }
    if (lines.length) result.push({ path, lines }), (total += lines.length);
  }
  return { files: result, total, truncated: false, cancelled: false };
}

// Fake sessions: a tiny line-echo "agent" per session, with status changes
// pushed as events like the real daemon does.
interface MockSession {
  info: Record<string, any>;
  history: string;
  line: string;
  channel?: { id: number };
  index: number;
}
const sessions = new Map<string, MockSession>();
const enc = new TextEncoder();
let seq = 0;

function out(s: MockSession, text: string) {
  s.history += text;
  if (!s.channel) return;
  const bytes = enc.encode(text);
  (window as any).__TAURI_INTERNALS__.runCallback(s.channel.id, { index: s.index++, message: bytes.buffer });
}

function setStatus(s: MockSession, status: string) {
  s.info = { ...s.info, status, updatedMs: now() };
  void emit("session-update", s.info);
}

function createSession(req: Record<string, any>) {
  const id = (++seq).toString(16).padStart(10, "0");
  const taken = new Set([...sessions.values()].map((x) => x.info.name));
  let n = 1;
  while (taken.has(`${req.agent}-${n}`)) n++;
  const name = req.name || req.worktree || `${req.agent}-${n}`;
  const s: MockSession = {
    info: {
      id,
      name,
      agent: req.agent,
      cwd: req.worktree ? `/mock/aurora.worktrees/${req.worktree}` : "/mock/aurora",
      workspace: "/mock/aurora",
      branch: req.worktree ?? "main",
      worktree: req.worktree ? `/mock/aurora.worktrees/${req.worktree}` : null,
      status: "running",
      alive: true,
      exitCode: null,
      createdMs: now(),
      updatedMs: now(),
      title: null,
      renamed: false,
    },
    history: "",
    line: "",
    index: 0,
  };
  sessions.set(id, s);
  out(s, `\x1b[38;5;79m✻\x1b[0m \x1b[1m${req.agent}\x1b[0m (mock) em \x1b[34m${s.info.cwd}\x1b[0m\r\n\r\n> `);
  setTimeout(() => setStatus(s, "waiting"), 1200);
  return s.info;
}

function input(s: MockSession, data: string) {
  if (!s.info.alive) return;
  for (const ch of data) {
    if (ch === "\r") {
      const line = s.line;
      s.line = "";
      out(s, "\r\n");
      if (!s.info.title && line) s.info = { ...s.info, title: line.charAt(0).toUpperCase() + line.slice(1) };
      setStatus(s, "running");
      setTimeout(() => {
        out(s, `\x1b[2m⏺ pensando em\x1b[0m “${line}”…\r\n\x1b[32m✓\x1b[0m feito.\r\n\r\n> `);
        setStatus(s, "done");
      }, 600);
    } else if (ch === "\x7f") {
      if (s.line) (s.line = s.line.slice(0, -1)), out(s, "\b \b");
    } else {
      s.line += ch;
      out(s, ch);
    }
  }
}

// Two schemes as the core maps them (`core::theme::load`).
const themes: Record<string, any>[] = [
  {
    "id": "catppuccin-mocha",
    "name": "Catppuccin Mocha",
    "variant": "dark",
    "tokens": {
      "--accent": "#89b4fa",
      "--accent-2": "#cba6f7",
      "--accent-fg": "#1e1e2e",
      "--ansi-black": "#181825",
      "--ansi-blue": "#89b4fa",
      "--ansi-bright-black": "#45475a",
      "--ansi-bright-blue": "#74c7ec",
      "--ansi-bright-cyan": "#89dceb",
      "--ansi-bright-green": "#a6e3a1",
      "--ansi-bright-magenta": "#f5c2e7",
      "--ansi-bright-red": "#eba0ac",
      "--ansi-bright-white": "#b4befe",
      "--ansi-bright-yellow": "#f5e0dc",
      "--ansi-cyan": "#94e2d5",
      "--ansi-green": "#a6e3a1",
      "--ansi-magenta": "#cba6f7",
      "--ansi-red": "#f38ba8",
      "--ansi-white": "#cdd6f4",
      "--ansi-yellow": "#f9e2af",
      "--bg": "#1e1e2e",
      "--bg-hover": "#222231",
      "--bg-panel": "#1c1c2a",
      "--bg-raised": "#181825",
      "--bg-select": "#313244",
      "--bg-select-dim": "#272838",
      "--cursor": "#cdd6f4",
      "--danger": "#f38ba8",
      "--fg": "#cdd6f4",
      "--fg-dim": "#585b70",
      "--fg-faint": "#45475a",
      "--info": "#94e2d5",
      "--line": "#252535",
      "--line-strong": "#3b3d4f",
      "--match": "#89b4fa",
      "--match-bg": "rgba(137, 180, 250, 0.18)",
      "--selection": "rgba(49, 50, 68, 0.8)",
      "--syn-attr": "#fab387",
      "--syn-comment": "#45475a",
      "--syn-function": "#89b4fa",
      "--syn-heading": "#89b4fa",
      "--syn-keyword": "#cba6f7",
      "--syn-link": "#94e2d5",
      "--syn-number": "#fab387",
      "--syn-operator": "#585b70",
      "--syn-property": "#f38ba8",
      "--syn-string": "#a6e3a1",
      "--syn-tag": "#f38ba8",
      "--syn-type": "#f9e2af",
      "--syn-variable": "#cdd6f4",
      "--warn": "#f9e2af",
      "color-scheme": "dark"
    }
  },
  {
    "id": "gruvbox-light",
    "name": "Gruvbox Light",
    "variant": "light",
    "tokens": {
      "--accent": "#458588",
      "--accent-2": "#b16286",
      "--accent-fg": "#fbf1c7",
      "--ansi-black": "#ebdbb2",
      "--ansi-blue": "#458588",
      "--ansi-bright-black": "#bdae93",
      "--ansi-bright-blue": "#076678",
      "--ansi-bright-cyan": "#427b58",
      "--ansi-bright-green": "#79740e",
      "--ansi-bright-magenta": "#8f3f71",
      "--ansi-bright-red": "#9d0006",
      "--ansi-bright-white": "#1d2021",
      "--ansi-bright-yellow": "#b57614",
      "--ansi-cyan": "#689d6a",
      "--ansi-green": "#98971a",
      "--ansi-magenta": "#b16286",
      "--ansi-red": "#cc241d",
      "--ansi-white": "#3c3836",
      "--ansi-yellow": "#d79921",
      "--bg": "#fbf1c7",
      "--bg-hover": "#e2d2ab",
      "--bg-panel": "#f5e8bf",
      "--bg-raised": "#ebdbb2",
      "--bg-select": "#d5c4a1",
      "--bg-select-dim": "#decda8",
      "--cursor": "#3c3836",
      "--danger": "#cc241d",
      "--fg": "#3c3836",
      "--fg-dim": "#7c6f64",
      "--fg-faint": "#bdae93",
      "--info": "#689d6a",
      "--line": "#e0d0aa",
      "--line-strong": "#c9b99a",
      "--match": "#458588",
      "--match-bg": "rgba(69, 133, 136, 0.18)",
      "--selection": "rgba(213, 196, 161, 0.8)",
      "--syn-attr": "#d65d0e",
      "--syn-comment": "#bdae93",
      "--syn-function": "#458588",
      "--syn-heading": "#458588",
      "--syn-keyword": "#b16286",
      "--syn-link": "#689d6a",
      "--syn-number": "#d65d0e",
      "--syn-operator": "#7c6f64",
      "--syn-property": "#cc241d",
      "--syn-string": "#98971a",
      "--syn-tag": "#cc241d",
      "--syn-type": "#d79921",
      "--syn-variable": "#3c3836",
      "--warn": "#d79921",
      "color-scheme": "light"
    }
  }
];

export function installMock() {
  mockWindows("main");
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, any>;
    switch (cmd) {
      case "initial_path":
        return "/mock/aurora";
      case "open_workspace":
        return { root: "/mock/aurora", name: "aurora" };
      case "list_dir":
        return listDir(a.path);
      case "read_file":
        if (!(a.path in files)) throw { kind: "not_found", message: "não encontrado" };
        return { content: files[a.path], stat: { mtimeMs: (mtimes[a.path] ??= now()), size: files[a.path].length } };
      case "write_file":
        files[a.path] = a.content;
        return { mtimeMs: (mtimes[a.path] = now()), size: a.content.length };
      case "stat_file":
        return { mtimeMs: mtimes[a.path] ?? now(), size: files[a.path]?.length ?? 0 };
      case "fuzzy_find":
        return fuzzy(a.query, a.limit ?? 50);
      case "search_text":
        return search(a.query);
      case "session_list":
        return [...sessions.values()].map((x) => x.info);
      case "session_create":
        return createSession(a.req);
      case "session_attach": {
        const s = sessions.get(a.id);
        if (!s) throw { kind: "session", message: "sessão não encontrada" };
        s.channel = a.onOutput;
        s.index = 0;
        const h = s.history;
        s.history = "";
        out(s, h);
        return null;
      }
      case "session_input":
        return input(sessions.get(a.id)!, a.data);
      case "session_kill": {
        const s = sessions.get(a.id)!;
        s.info = { ...s.info, alive: false, status: "done", exitCode: 129, updatedMs: now() };
        void emit("session-update", s.info);
        return null;
      }
      case "session_rename": {
        const s = sessions.get(a.id)!;
        s.info = { ...s.info, name: a.name, renamed: true };
        void emit("session-update", s.info);
        return s.info;
      }
      case "list_themes":
        return { dir: "/mock/themes", themes: themes.map(({ id, name, variant }) => ({ id, name, variant })) };
      case "load_theme": {
        const t = themes.find((x) => x.id === a.id);
        if (!t) throw { kind: "bad_theme", message: `tema: tema não encontrado: ${a.id}` };
        return t;
      }
      case "session_worktree_dirty":
        return a.id.endsWith("2");
      case "session_remove":
        sessions.delete(a.id);
        void emit("session-removed", a.id);
        return null;
      default:
        return null;
    }
  }, { shouldMockEvents: true });
}
