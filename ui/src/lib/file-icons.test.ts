import { describe, expect, it } from "vitest";
import { fileIcon } from "./file-icons";

describe("fileIcon", () => {
  it("picks folders by state and files by name, then extension", () => {
    expect(fileIcon("src", true)).toEqual({ icon: "folder", tone: "folder" });
    expect(fileIcon("src", true, true)).toEqual({ icon: "folder-open", tone: "folder" });
    expect(fileIcon("main.rs", false)).toEqual({ icon: "file-code", tone: "code" });
    expect(fileIcon("README.md", false)).toEqual({ icon: "book", tone: "doc" });
    expect(fileIcon("notes.MD", false)).toEqual({ icon: "markdown", tone: "doc" });
    expect(fileIcon("pnpm-lock.yaml", false)).toEqual({ icon: "lock", tone: "config" });
    expect(fileIcon("Cargo.toml", false)).toEqual({ icon: "settings", tone: "config" });
    expect(fileIcon(".env.local", false)).toEqual({ icon: "settings", tone: "config" });
    expect(fileIcon(".gitignore", false)).toEqual({ icon: "git", tone: "config" });
  });

  it("falls back to a plain file", () => {
    expect(fileIcon("Procfile", false)).toEqual({ icon: "file", tone: "plain" });
    expect(fileIcon(".hidden", false)).toEqual({ icon: "file", tone: "plain" });
  });
});
