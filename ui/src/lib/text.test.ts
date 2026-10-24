import { describe, expect, it } from "vitest";
import { detectEol, formatBytes } from "./text";

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
