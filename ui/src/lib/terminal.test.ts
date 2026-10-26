import { describe, expect, it } from "vitest";
import { clearOf } from "./terminal";

describe("clearOf", () => {
  it("keeps the color and drops the alpha", () => {
    expect(clearOf("#070f0b")).toBe("rgba(7, 15, 11, 0)");
    expect(clearOf(" #FFF ")).toBe("rgba(255, 255, 255, 0)");
    expect(clearOf("tomato")).toBe("rgba(0, 0, 0, 0)");
  });
});
