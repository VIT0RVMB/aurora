import { describe, expect, it } from "vitest";
import { clearOf, isDeadCommit } from "./terminal";

describe("clearOf", () => {
  it("keeps the color and drops the alpha", () => {
    expect(clearOf("#070f0b")).toBe("rgba(7, 15, 11, 0)");
    expect(clearOf(" #FFF ")).toBe("rgba(255, 255, 255, 0)");
    expect(clearOf("tomato")).toBe("rgba(0, 0, 0, 0)");
  });
});

describe("isDeadCommit", () => {
  it("is text of several characters, not a key name", () => {
    expect(isDeadCommit("'s")).toBe(true);
    expect(isDeadCommit("é")).toBe(false);
    expect(isDeadCommit("s")).toBe(false);
    expect(isDeadCommit("🙂")).toBe(false);
    expect(isDeadCommit("Enter")).toBe(false);
    expect(isDeadCommit("Dead")).toBe(false);
    expect(isDeadCommit("F12")).toBe(false);
  });
});
