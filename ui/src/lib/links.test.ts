import { describe, expect, it } from "vitest";
import { joinPath, pickWiki, resolveHref, resolveWiki, slug } from "./links";

describe("links", () => {
  it("resolves relative, rooted and anchored hrefs", () => {
    expect(resolveHref("docs/guide/a.md", "../b.md")).toEqual({ kind: "file", path: "docs/b.md", anchor: null });
    expect(resolveHref("docs/a.md", "/README.md#Install")).toEqual({ kind: "file", path: "README.md", anchor: "Install" });
    expect(resolveHref("a.md", "my%20notes.md")).toEqual({ kind: "file", path: "my notes.md", anchor: null });
    expect(resolveHref("a.md", "#usage")).toEqual({ kind: "anchor", anchor: "usage" });
    expect(resolveHref("a.md", "https://x.dev")).toEqual({ kind: "external", url: "https://x.dev" });
    expect(resolveHref("a.md", "javascript:alert(1)")).toBeNull();
    expect(resolveHref("a.md", "../../etc/passwd")).toBeNull();
  });

  it("joins paths", () => {
    expect(joinPath("a/b", "./c/../d")).toBe("a/b/d");
    expect(joinPath("", "..")).toBeNull();
  });

  it("parses and picks wiki targets", () => {
    expect(resolveWiki("Plan#Phase 3|the plan")).toEqual({ kind: "wiki", name: "Plan", anchor: "Phase 3" });
    expect(resolveWiki("#top")).toEqual({ kind: "anchor", anchor: "top" });
    const files = ["src/plan.ts", "notes/old/plan.md", "Plan.md", "docs/plan-b.md"];
    expect(pickWiki("plan", files)).toBe("Plan.md");
    expect(pickWiki("old/plan", files)).toBe("notes/old/plan.md");
    expect(pickWiki("nope", files)).toBeNull();
  });

  it("slugs headings like GitHub", () => {
    expect(slug("Phase 3 — Markdown, rich!")).toBe("phase-3--markdown-rich");
  });
});
