import { describe, expect, it } from "vitest";
import { ago, detectEol, formatBytes, shortPath } from "./text";

describe("detectEol", () => {
  it("detects pure CRLF only", () => {
    expect(detectEol("a\r\nb\r\n")).toBe("crlf");
    expect(detectEol("a\nb")).toBe("lf");
    expect(detectEol("a\r\nb\nc")).toBe("lf");
    expect(detectEol("")).toBe("lf");
  });
  it("formats sizes", () => {
    expect(formatBytes(10)).toBe("10 B");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("shortPath", () => {
  it("keeps the last two segments", () => {
    expect(shortPath("/Users/me/code/aurora/ui")).toBe("aurora/ui");
    expect(shortPath("C:\\code\\x")).toBe("code/x");
  });
});

describe("ago", () => {
  it("rounds down to the largest unit", () => {
    const now = 1_000_000_000;
    expect(ago(now - 5_000, now)).toBe("now");
    expect(ago(now - 5 * 60_000, now)).toBe("5m");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3h");
    expect(ago(now - 2 * 86_400_000, now)).toBe("2d");
    expect(ago(now - 21 * 86_400_000, now)).toBe("3w");
    expect(ago(now + 5_000, now)).toBe("now");
  });
});
