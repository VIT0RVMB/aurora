import { describe, expect, it } from "vitest";
import type { DirEntry } from "./ipc";
import { ancestors, baseName, flattenTree, parentPath } from "./tree";

const d = (path: string): DirEntry => ({ path, name: baseName(path), isDir: true });
const f = (path: string): DirEntry => ({ path, name: baseName(path), isDir: false });

describe("flattenTree", () => {
  const children = {
    "": [d("src"), d("docs"), f("README.md")],
    src: [d("src/ui"), f("src/main.rs")],
    "src/ui": [f("src/ui/app.tsx")],
  };

  it("shows only expanded directories, depth-first", () => {
    const rows = flattenTree(children, new Set(["src", "src/ui"]));
    expect(rows.map((r) => [r.entry.path, r.depth])).toEqual([
      ["src", 0],
      ["src/ui", 1],
      ["src/ui/app.tsx", 2],
      ["src/main.rs", 1],
      ["docs", 0],
      ["README.md", 0],
    ]);
  });

  it("hides children of collapsed dirs and flags pending loads", () => {
    const rows = flattenTree(children, new Set(["src/ui", "docs"]));
    expect(rows.map((r) => r.entry.path)).toEqual(["src", "docs", "README.md"]);
    expect(rows.find((r) => r.entry.path === "docs")?.loading).toBe(true);
  });
});

describe("path helpers", () => {
  it("splits paths", () => {
    expect(parentPath("a/b/c.rs")).toBe("a/b");
    expect(parentPath("c.rs")).toBe("");
    expect(baseName("a/b/c.rs")).toBe("c.rs");
    expect(ancestors("a/b/c.rs")).toEqual(["a", "a/b"]);
    expect(ancestors("c.rs")).toEqual([]);
  });
});
