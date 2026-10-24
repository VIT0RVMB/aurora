import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./ipc";
import { close, cycle, emptyLayout, prune, show, split, unsplit, type Layout } from "./panes";
import { displayName, parseSessionCommand, resolveSession, sortSessions, statusView } from "./sessions";

const s = (over: Partial<SessionInfo>): SessionInfo => ({
  id: "id",
  name: "n",
  agent: "claude",
  cwd: "/w",
  workspace: "/w",
  branch: null,
  worktree: null,
  status: "running",
  alive: true,
  exitCode: null,
  createdMs: 0,
  updatedMs: 0,
  title: null,
  renamed: false,
  ...over,
});

describe("parseSessionCommand", () => {
  it("parses new with worktree, name and passthrough args", () => {
    expect(parseSessionCommand(["new", "claude", "--worktree", "fix-login", "-n", "login", "--", "--model", "opus"])).toEqual({
      sub: "new",
      agent: "claude",
      worktree: "fix-login",
      name: "login",
      args: ["--model", "opus"],
    });
    expect(parseSessionCommand(["n", "codex", "-w=x"])).toMatchObject({ sub: "new", agent: "codex", args: ["-w=x"] });
    expect(parseSessionCommand(["new", "codex", "--worktree=x"])).toMatchObject({ worktree: "x" });
  });

  it("reports usage errors", () => {
    expect(parseSessionCommand(["new"])).toHaveProperty("error");
    expect(parseSessionCommand(["new", "claude", "--worktree"])).toHaveProperty("error");
    expect(parseSessionCommand(["rename"])).toHaveProperty("error");
    expect(parseSessionCommand(["frobnicate"])).toHaveProperty("error");
  });

  it("handles rename forms and aliases", () => {
    expect(parseSessionCommand(["rename", "novo"])).toEqual({ sub: "rename", name: "novo" });
    expect(parseSessionCommand(["mv", "a", "b"])).toEqual({ sub: "rename", target: "a", name: "b" });
    expect(parseSessionCommand(["close"])).toEqual({ sub: "rm", target: undefined });
    expect(parseSessionCommand([])).toEqual({ sub: "list" });
  });
});

describe("resolveSession", () => {
  const list = [s({ id: "a1", name: "claude-1" }), s({ id: "b2", name: "claude-2" }), s({ id: "c3", name: "codex" })];
  it("prefers exact name, then id prefix, then unique name prefix", () => {
    expect(resolveSession(list, "codex", null)).toBe(list[2]);
    expect(resolveSession(list, "b", null)).toBe(list[1]);
    expect(resolveSession(list, "cod", null)).toBe(list[2]);
    expect(resolveSession(list, "claude", null)).toMatch(/ambíguo/);
    expect(resolveSession(list, "zzz", null)).toMatch(/não encontrada/);
    expect(resolveSession(list, undefined, "a1")).toBe(list[0]);
    expect(typeof resolveSession(list, undefined, null)).toBe("string");
  });
});

describe("status", () => {
  it("maps states to the four labels plus ended", () => {
    expect(statusView(s({ status: "waiting" })).label).toBe("aguardando você");
    expect(statusView(s({ status: "done" })).label).toBe("terminou");
    expect(statusView(s({ alive: false, status: "error", exitCode: 2 })).label).toBe("erro (2)");
    expect(statusView(s({ alive: false, status: "done" })).label).toBe("encerrado");
  });

  it("sorts waiting sessions first and ended last", () => {
    const list = [
      s({ id: "dead", alive: false, createdMs: 0 }),
      s({ id: "run", createdMs: 1 }),
      s({ id: "wait", status: "waiting", createdMs: 2 }),
    ];
    expect(sortSessions(list).map((x) => x.id)).toEqual(["wait", "run", "dead"]);
  });
});

describe("panes", () => {
  const open = (...ids: string[]) => ids.reduce<Layout>((l, id) => show(l, id), emptyLayout());

  it("adds to the focused pane and re-activates existing tabs", () => {
    const l = show(open("a", "b"), "a");
    expect(l.panes).toEqual([{ id: 1, tabs: ["a", "b"], active: "a" }]);
  });

  it("splits the active session into a new pane, and refuses with one tab", () => {
    expect(typeof split(open("a"))).toBe("string");
    const l = split(open("a", "b")) as Layout;
    expect(l.panes.map((p) => p.tabs)).toEqual([["a"], ["b"]]);
    expect(l.focused).toBe(2);
    // New sessions land in the focused (new) pane.
    expect(show(l, "c").panes[1].tabs).toEqual(["b", "c"]);
  });

  it("closes emptied panes but keeps the last one", () => {
    const l = split(open("a", "b")) as Layout;
    const after = close(l, "b");
    expect(after.panes).toEqual([{ id: 1, tabs: ["a"], active: "a" }]);
    expect(after.focused).toBe(1);
    expect(close(after, "a").panes).toEqual([{ id: 1, tabs: [], active: null }]);
  });

  it("unsplits, cycles and prunes", () => {
    const l = split(open("a", "b", "c")) as Layout;
    expect(unsplit(l).panes).toEqual([{ id: 1, tabs: ["a", "b", "c"], active: "c" }]);
    expect(cycle(open("a", "b", "c"), 1).panes[0].active).toBe("a");
    expect(prune(l, new Set(["a"])).panes).toEqual([{ id: 1, tabs: ["a"], active: "a" }]);
  });
});

describe("displayName", () => {
  it("uses the agent topic unless renamed or generic", () => {
    expect(displayName(s({ name: "claude-1" }))).toBe("claude-1");
    expect(displayName(s({ name: "claude-1", title: "Claude Code" }))).toBe("claude-1");
    expect(displayName(s({ name: "claude-1", title: "Corrigir login" }))).toBe("Corrigir login");
    expect(displayName(s({ name: "meu", title: "Corrigir login", renamed: true }))).toBe("meu");
  });

  it("lets commands target a session by its topic", () => {
    const list = [s({ id: "a1", name: "claude-1", title: "Corrigir login" })];
    expect(resolveSession(list, "Corrigir login", null)).toBe(list[0]);
  });
});
