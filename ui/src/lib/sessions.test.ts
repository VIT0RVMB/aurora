import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./ipc";
import { displayName, parseSessionCommand, parseStage, resolveSession, sortSessions, statusView } from "./sessions";

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
  stage: "inbox",
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
    expect(resolveSession(list, "claude", null)).toMatch(/ambiguous/);
    expect(resolveSession(list, "zzz", null)).toMatch(/not found/);
    expect(resolveSession(list, undefined, "a1")).toBe(list[0]);
    expect(typeof resolveSession(list, undefined, null)).toBe("string");
  });
});

describe("status", () => {
  it("maps states to the four labels plus ended", () => {
    expect(statusView(s({ status: "waiting" })).label).toBe("waiting for you");
    expect(statusView(s({ status: "done" })).label).toBe("done");
    expect(statusView(s({ alive: false, status: "error", exitCode: 2 })).label).toBe("error (2)");
    expect(statusView(s({ alive: false, status: "done" })).label).toBe("exited");
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

describe("session color and archive commands", () => {
  it("parses them", () => {
    expect(parseSessionCommand(["color", "blue", "x"])).toEqual({ sub: "color", color: "blue", target: "x" });
    expect(parseSessionCommand(["color", "none"])).toEqual({ sub: "color", color: null, target: undefined });
    expect(parseSessionCommand(["color", "chartreuse"])).toHaveProperty("error");
    expect(parseSessionCommand(["archive"])).toEqual({ sub: "archive", target: undefined });
    expect(parseSessionCommand(["unarchive", "claude-1"])).toEqual({ sub: "unarchive", target: "claude-1" });
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

describe("session stage", () => {
  it("parses stages by name or unique prefix", () => {
    expect(parseStage("impl")).toBe("implementing");
    expect(parseStage("VAL")).toBe("validating");
    expect(parseStage("")).toBeNull();
    expect(parseStage("x")).toBeNull();
  });
  it("parses :session stage", () => {
    expect(parseSessionCommand(["stage", "plan"])).toEqual({ sub: "stage", stage: "planning", target: undefined });
    expect(parseSessionCommand(["st", "complete", "codex-1"])).toEqual({ sub: "stage", stage: "complete", target: "codex-1" });
    expect(parseSessionCommand(["stage", "nope"])).toHaveProperty("error");
  });
});
