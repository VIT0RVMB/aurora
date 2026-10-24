import { describe, expect, it } from "vitest";
import { findCommand, isOutsidePath, parseCommand, suggest, type CommandSpec } from "./commands";

const specs: CommandSpec[] = [
  { name: "open", aliases: ["o"], usage: "[pasta|arquivo]", description: "abrir" },
  { name: "theme", argChoices: ["dark", "light", "toggle"], description: "tema" },
  { name: "quit", aliases: ["q"], description: "sair" },
];

describe("parseCommand", () => {
  it("splits name and args, with quotes", () => {
    expect(parseCommand(':open "~/my code" x')).toEqual({ name: "open", args: ["~/my code", "x"] });
    expect(parseCommand("  :THEME   dark ")).toEqual({ name: "theme", args: ["dark"] });
    expect(parseCommand('open ""')).toEqual({ name: "open", args: [""] });
  });
  it("returns null without a name", () => {
    expect(parseCommand(":")).toBeNull();
    expect(parseCommand("   ")).toBeNull();
  });
});

describe("findCommand", () => {
  it("resolves aliases", () => {
    expect(findCommand(specs, "q")?.name).toBe("quit");
    expect(findCommand(specs, "nope")).toBeUndefined();
  });
});

describe("suggest", () => {
  it("lists commands by prefix and alias", () => {
    expect(suggest(specs, ":").map((s) => s.label)).toEqual([":open [pasta|arquivo]", ":theme", ":quit"]);
    expect(suggest(specs, ":q").map((s) => s.value)).toEqual([":quit"]);
    expect(suggest(specs, ":o")[0].value).toBe(":open ");
  });
  it("completes argument choices", () => {
    expect(suggest(specs, ":theme l").map((s) => s.value)).toEqual([":theme light"]);
    expect(suggest(specs, ":quit x")).toEqual([]);
  });
});

describe("isOutsidePath", () => {
  it("detects absolute and home paths", () => {
    for (const p of ["/tmp", "~/x", "~", "C:\\code", "d:/x"]) expect(isOutsidePath(p)).toBe(true);
    for (const p of ["src/main.rs", "README.md"]) expect(isOutsidePath(p)).toBe(false);
  });
});

describe("dynamic completion", () => {
  const specs = [
    {
      name: "session",
      description: "sessões",
      complete: (before: string[]) => (before.length === 0 ? ["new", "kill"] : before.length === 1 && before[0] === "new" ? ["claude", "codex"] : []),
    },
  ];
  it("completes each argument from the ones before it", () => {
    expect(suggest(specs, ":session k").map((s) => s.value)).toEqual([":session kill"]);
    expect(suggest(specs, ":session new c").map((s) => s.value)).toEqual([":session new claude", ":session new codex"]);
    expect(suggest(specs, ":session new claude ")).toEqual([]);
  });
});
