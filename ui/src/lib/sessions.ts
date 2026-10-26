// Pure helpers for agent sessions: `:session` argument parsing, target lookup
// and how a status is shown. No IPC here, so it is unit-tested.
import { SESSION_COLORS, type SessionInfo, type Stage } from "./ipc";
import { t } from "./i18n";

export type SessionCommand =
  | { sub: "new"; agent: string; worktree?: string; name?: string; args: string[] }
  | { sub: "kill"; target?: string }
  | { sub: "rename"; target?: string; name: string }
  | { sub: "rm"; target?: string }
  | { sub: "focus"; target: string }
  | { sub: "stage"; stage: Stage; target?: string }
  | { sub: "diff"; target?: string }
  | { sub: "archive"; target?: string }
  | { sub: "unarchive"; target?: string }
  | { sub: "color"; color: string | null; target?: string }
  | { sub: "list" };

export const SUBCOMMANDS = [
  "new",
  "kill",
  "rename",
  "rm",
  "focus",
  "stage",
  "diff",
  "color",
  "archive",
  "unarchive",
  "list",
] as const;
export const STAGES: Stage[] = ["inbox", "planning", "implementing", "validating", "complete"];

/** A stage by name or unique prefix (`impl`, `val`). */
export function parseStage(s: string): Stage | null {
  const v = s.toLowerCase();
  const hits = STAGES.filter((st) => st.startsWith(v));
  return v && hits.length === 1 ? hits[0] : null;
}
const ALIASES: Record<string, (typeof SUBCOMMANDS)[number]> = {
  n: "new",
  k: "kill",
  mv: "rename",
  remove: "rm",
  close: "rm",
  f: "focus",
  go: "focus",
  ls: "list",
  st: "stage",
  d: "diff",
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
          if (!worktree) return { error: t("sess.worktreeName") };
        } else if (a.startsWith("--worktree=")) worktree = a.slice("--worktree=".length);
        else if (a === "--name" || a === "-n") {
          name = rest[++i];
          if (!name) return { error: t("sess.nameName") };
        } else if (!agent && !a.startsWith("-")) agent = a;
        else extra.push(a);
      }
      if (!agent) return { error: t("sess.usageNew") };
      return { sub: "new", agent, worktree, name, args: extra };
    }
    case "kill":
      return { sub: "kill", target: rest[0] };
    case "rm":
      return { sub: "rm", target: rest[0] };
    case "rename":
      if (rest.length === 1) return { sub: "rename", name: rest[0] };
      if (rest.length === 2) return { sub: "rename", target: rest[0], name: rest[1] };
      return { error: t("sess.usageRename") };
    case "focus":
      if (!rest[0]) return { error: t("sess.usageFocus") };
      return { sub: "focus", target: rest[0] };
    case "stage": {
      const stage = rest[0] ? parseStage(rest[0]) : null;
      if (!stage) return { error: t("sess.usageStage") };
      return { sub: "stage", stage, target: rest[1] };
    }
    case "diff":
      return { sub: "diff", target: rest[0] };
    case "archive":
    case "unarchive":
      return { sub, target: rest[0] };
    case "color": {
      const c = rest[0]?.toLowerCase();
      if (!c || (c !== "none" && !SESSION_COLORS.includes(c))) return { error: t("sess.usageColor") };
      return { sub: "color", color: c === "none" ? null : c, target: rest[1] };
    }
    case "list":
      return { sub: "list" };
    default:
      return { error: t("sess.unknownSub", { sub: rawSub }) };
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
  if (!target) return list.find((s) => s.id === activeId) ?? t("sess.noActive");
  const exact = list.find((s) => s.name === target) ?? list.find((s) => displayName(s) === target);
  if (exact) return exact;
  const byId = list.filter((s) => s.id.startsWith(target));
  if (byId.length === 1) return byId[0];
  const byName = list.filter((s) => s.name.startsWith(target));
  if (byName.length === 1) return byName[0];
  return byName.length > 1 ? t("sess.ambiguous", { list: byName.map((s) => s.name).join(", ") }) : t("sess.notFound", { name: target });
}

/** Titles agents show before there is a topic; they say less than the name. */
const GENERIC_TITLES = new Set(["claude code", "claude", "codex", "opencode", "agy", "antigravity"]);

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
    if (s.status === "error") return { glyph: "✗", label: s.exitCode != null ? t("status.errorCode", { code: s.exitCode }) : t("status.error"), tone: "danger" };
    return { glyph: "■", label: t("status.exited"), tone: "faint" };
  }
  switch (s.status) {
    case "running":
      return { glyph: "●", label: t("status.running"), tone: "accent" };
    case "waiting":
      return { glyph: "◆", label: t("status.waiting"), tone: "warn" };
    case "done":
      return { glyph: "✓", label: t("status.done"), tone: "dim" };
    case "error":
      return { glyph: "✗", label: t("status.error"), tone: "danger" };
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
