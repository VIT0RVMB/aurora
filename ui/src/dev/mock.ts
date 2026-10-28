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
  "ui/src/main.tsx": 'import { render } from "solid-js/web";\nrender(() => <App />, document.body);\n',};
files["docs/rich.md"] = [
  "---",
  "title: Rich markdown",
  "status: draft",
  "published: false",
  "tags: [docs, editor]",
  "aliases:",
  "  - rich",
  "  - live preview",
  "---",
  "# Rich markdown",
  "",
  "Some **bold**, *italic*, `code`, ~~gone~~ and a [link to notes](notes.md#second) or [[notes|wiki link]].",
  "",
  "## Tasks",
  "",
  "- [x] parse with lezer",
  "- [ ] render tables",
  "- plain bullet",
  "  - nested bullet",
  "",
  "> A quote from an agent.",
  "",
  "| file | status | lines |",
  "|:-----|:------:|------:|",
  "| a.rs | added | 120 |",
  "| b.ts | changed | 8 |",
  "",
  "```ts",
  "const answer: number = 42; // highlighted",
  "```",
  "",
  "```mermaid",
  "graph LR; agent-->worktree; worktree-->review",
  "```",
  "",
  "---",
  "",
  "![logo](logo.svg)",
  "",
].join("\n");
files["docs/notes.md"] = "# Notes\n\nfirst\n\n## Second\n\nhere\n";
files["docs/logo.svg"] = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#c96"/><text x="10" y="26" font-family="monospace">aurora</text></svg>';
for (let i = 0; i < 300; i++) files[`fixtures/many/file${String(i).padStart(3, "0")}.txt`] = `linha ${i}\n`;

// ~5 MB file to check that big buffers open without freezing the UI.
files["fixtures/big.rs"] = Array.from({ length: 90_000 }, (_, i) => `fn item_${i}() -> u64 { ${i} * 2 + 1 } // ${"x".repeat(20)}`).join("\n");

const mtimes: Record<string, number> = {};
const now = () => Date.now();

/** Folders made by `create_dir` that hold no file yet. */
const emptyDirs = new Set<string>();

function listDir(dir: string) {
  const prefix = dir ? `${dir}/` : "";
  const seen = new Map<string, boolean>();
  for (const p of [...Object.keys(files), ...[...emptyDirs].map((d) => `${d}/`)]) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (!rest) continue;
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
      stage: "inbox",
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
      case "read_image":
        return a.path in files && a.path.endsWith(".svg")
          ? `data:image/svg+xml;base64,${btoa(files[a.path])}`
          : null;
      case "open_url":
        return null;
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
      case "session_set_color":
      case "session_set_archived": {
        const s = sessions.get(a.id)!;
        s.info = cmd === "session_set_color" ? { ...s.info, color: a.color } : { ...s.info, archived: a.archived };
        void emit("session-update", s.info);
        return s.info;
      }
      case "trash_path": {
        for (const p of Object.keys(files)) if (p === a.path || p.startsWith(`${a.path}/`)) delete files[p];
        void emit("fs-change", { changed: [a.path], dirs: [], rescan: true });
        return null;
      }
      case "file_history":
        return [
          { hash: "c3c3c3c3", short: "c3c3c3c", author: "Ana", timeMs: now() - 3600e3, subject: "say hi in English", path: a.path },
          { hash: "b2b2b2b2", short: "b2b2b2b", author: "Vitor", timeMs: now() - 86400e3 * 3, subject: "add hello", path: a.path },
        ];
      case "commit_diff":
        return a.hash.startsWith("c")
          ? { old: files[a.path] ?? "", new: (files[a.path] ?? "").replace("olá", "hello") }
          : { old: null, new: files[a.path] ?? "" };
      case "worktrees":
        return [
          { path: "/mock/aurora", branch: "main", main: true, changed: 3 },
          ...[...sessions.values()]
            .filter((x) => x.info.worktree)
            .map((x) => ({ path: x.info.worktree, branch: x.info.branch, main: false, changed: 0 })),
          { path: "/mock/aurora.worktrees/spike", branch: "spike", main: false, changed: 1 },
        ];
      case "share_link":
        return `https://github.com/me/aurora/blob/main/${a.path}`;
      case "create_file": {
        if (a.path in files) throw { kind: "exists", message: "already exists", detail: a.path };
        files[a.path] = "";
        const dir = a.path.includes("/") ? a.path.slice(0, a.path.lastIndexOf("/")) : "";
        void emit("fs-change", { changed: [a.path], dirs: [dir], rescan: false });
        return { mtimeMs: now(), size: 0 };
      }
      case "create_dir": {
        if (emptyDirs.has(a.path) || Object.keys(files).some((p) => p === a.path || p.startsWith(`${a.path}/`))) {
          throw { kind: "exists", message: "already exists", detail: a.path };
        }
        emptyDirs.add(a.path);
        const dir = a.path.includes("/") ? a.path.slice(0, a.path.lastIndexOf("/")) : "";
        void emit("fs-change", { changed: [], dirs: [dir], rescan: false });
        return null;
      }
      case "rename_path": {
        if (a.to in files) throw { kind: "exists", message: "already exists", detail: a.to };
        for (const p of Object.keys(files)) {
          if (p === a.from || p.startsWith(`${a.from}/`)) {
            files[a.to + p.slice(a.from.length)] = files[p];
            delete files[p];
          }
        }
        void emit("fs-change", { changed: [a.from, a.to], dirs: [], rescan: true });
        return null;
      }
      case "session_set_stage": {
        const s = sessions.get(a.id)!;
        s.info = { ...s.info, stage: a.stage };
        void emit("session-update", s.info);
        return s.info;
      }
      case "session_rename": {
        const s = sessions.get(a.id)!;
        s.info = { ...s.info, name: a.name, renamed: true };
        void emit("session-update", s.info);
        return s.info;
      }
      case "session_changes": {
        const wt = sessions.get(a.id)?.info.worktree;
        return {
          root: wt ?? "/mock/aurora",
          base: "3588855aa1b2c3d4",
          files: wt
            ? [
                { path: "crates/core/src/lib.rs", kind: "modified", wsPath: "crates/core/src/lib.rs" },
                { path: "crates/core/src/diff.rs", kind: "added", wsPath: "crates/core/src/diff.rs" },
                { path: "Cargo.toml", kind: "deleted", wsPath: "Cargo.toml" },
              ]
            : [{ path: "README.md", kind: "modified", wsPath: "README.md" }],
        };
      }
      case "session_file_diff":
        if (a.path === "crates/core/src/diff.rs") return { old: null, new: "pub fn diff() -> usize {\n    0\n}\n" };
        if (a.path === "Cargo.toml") return { old: files["Cargo.toml"], new: null };
        return {
          old: files[a.path] ?? "",
          new: (files[a.path] ?? "").replace("olá", "oi").replace("terminal", "terminal e agentes") + "\n// new line from the agent\n",
        };
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
