import { describe, expect, it } from "vitest";
import { buildMarks } from "./marks";

describe("buildMarks", () => {
  it("marks files and their folders, merging sessions", () => {
    const m = buildMarks([
      { name: "a", files: [{ path: "src/x.rs", kind: "modified", wsPath: "src/x.rs" }, { path: "out.rs", kind: "added", wsPath: null }] },
      { name: "b", files: [{ path: "src/x.rs", kind: "modified", wsPath: "src/x.rs" }, { path: "src/deep/y.md", kind: "added", wsPath: "src/deep/y.md" }] },
    ]);
    expect(m.files.get("src/x.rs")).toEqual({ kind: "modified", sessions: ["a", "b"] });
    expect(m.files.has("out.rs")).toBe(false);
    expect(m.dirs.get("src")).toEqual(["a", "b"]);
    expect(m.dirs.get("src/deep")).toEqual(["b"]);
  });
});
