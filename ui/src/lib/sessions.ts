// Pure helpers for agent sessions: `:session` argument parsing, target lookup
// and how a status is shown. No IPC here, so it is unit-tested.
import type { SessionInfo } from "./ipc";

export type SessionCommand =
  | { sub: "new"; agent: string; worktree?: string; name?: string; args: string[] }
  | { sub: "kill"; target?: string }
  | { sub: "rename"; target?: string; name: string }
  | { sub: "rm"; target?: string }
  | { sub: "focus"; target: string }
  | { sub: "list" };

export const SUBCOMMANDS = ["new", "kill", "rename", "rm", "focus", "list"] as const;
const ALIASES: Record<string, (typeof SUBCOMMANDS)[number]> = {
  n: "new",
  k: "kill",
  mv: "rename",
  remove: "rm",
  close: "rm",
  f: "focus",
  go: "focus",
  ls: "list",
};

/** `:session new claude --worktree fix-login -- --model opus` and friends. */
export function parseSessionCommand(args: string[]): SessionCommand | { error: string } {
  const [rawSub, ...rest] = args;
  if (!rawSub) return { sub: "list" };
  const sub = ALIASES[rawSub] ?? rawSub;
  switch (sub) {
    case "new": {
      let agent: string | undefined;
      let worktree: string | undefined;
      let name: string | undefined;
      const extra: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "--") {
          extra.push(...rest.slice(i + 1));
          break;
        }
        if (a === "--worktree" || a === "-w") {
          worktree = rest[++i];
          if (!worktree) return { error: "--worktree pede um nome" };
        } else if (a.startsWith("--worktree=")) worktree = a.slice("--worktree=".length);
        else if (a === "--name" || a === "-n") {
          name = rest[++i];
          if (!name) return { error: "--name pede um nome" };
        } else if (!agent && !a.startsWith("-")) agent = a;
        else extra.push(a);
      }
      if (!agent) return { error: "uso: :session new <agente> [--worktree <nome>] [--name <nome>] [-- args]" };
      return { sub: "new", agent, worktree, name, args: extra };
    }
    case "kill":
      return { sub: "kill", target: rest[0] };
    case "rm":
      return { sub: "rm", target: rest[0] };
    case "rename":
      if (rest.length === 1) return { sub: "rename", name: rest[0] };
      if (rest.length === 2) return { sub: "rename", target: rest[0], name: rest[1] };
      return { error: "uso: :session rename [sessão] <novo-nome>" };
    case "focus":
      if (!rest[0]) return { error: "uso: :session focus <sessão>" };
      return { sub: "focus", target: rest[0] };
    case "list":
      return { sub: "list" };
    default:
      return { error: `subcomando desconhecido: ${rawSub}` };
  }
}

/**
 * Finds the session a command refers to: exact name, then id prefix, then a
 * unique name prefix. Without a target, the active one.
 */
export function resolveSession(
  list: SessionInfo[],
  target: string | undefined,
  activeId: string | null,
): SessionInfo | string {
  if (!target) return list.find((s) => s.id === activeId) ?? "nenhuma sessão ativa";
  const exact = list.find((s) => s.name === target) ?? list.find((s) => displayName(s) === target);
  if (exact) return exact;
  const byId = list.filter((s) => s.id.startsWith(target));
  if (byId.length === 1) return byId[0];
  const byName = list.filter((s) => s.name.startsWith(target));
  if (byName.length === 1) return byName[0];
  return byName.length > 1 ? `ambíguo: ${byName.map((s) => s.name).join(", ")}` : `sessão não encontrada: ${target}`;
}

/** Titles agents show before there is a topic; they say less than the name. */
const GENERIC_TITLES = new Set(["claude code", "claude", "codex", "opencode", "gemini"]);

/** What to call a session: your rename, else the agent's topic, else the name. */
export function displayName(s: Pick<SessionInfo, "name" | "title" | "renamed">): string {
  if (s.renamed || !s.title) return s.name;
  return GENERIC_TITLES.has(s.title.trim().toLowerCase()) ? s.name : s.title;
}

export type Tone = "accent" | "warn" | "dim" | "danger" | "faint";

export interface StatusView {
  glyph: string;
  label: string;
  tone: Tone;
}

export function statusView(s: Pick<SessionInfo, "status" | "alive" | "exitCode">): StatusView {
  if (!s.alive) {
    if (s.status === "error") return { glyph: "✗", label: `erro${s.exitCode != null ? ` (${s.exitCode})` : ""}`, tone: "danger" };
    return { glyph: "■", label: "encerrado", tone: "faint" };
  }
  switch (s.status) {
    case "running":
      return { glyph: "●", label: "rodando", tone: "accent" };
    case "waiting":
      return { glyph: "◆", label: "aguardando você", tone: "warn" };
    case "done":
      return { glyph: "✓", label: "terminou", tone: "dim" };
    case "error":
      return { glyph: "✗", label: "erro", tone: "danger" };
  }
}

/** Sessions that need you first, then by creation. */
export function sortSessions(list: SessionInfo[]): SessionInfo[] {
  const rank = (s: SessionInfo) => (s.alive && s.status === "waiting" ? 0 : s.alive ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.createdMs - b.createdMs);
}

/** Paths from the core may use either separator; compare them loosely. */
export function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm(a) === norm(b);
}
