import { describe, expect, it } from "vitest";
import { parseFrontmatter, writeValue } from "./markdown-frontmatter";

const DOC = `---
title: My note # a comment
quoted: "a \\"b\\" c"
single: 'it''s'
empty:
draft: true
tags: [one, "two, three"]
aliases:
  - first
  - 'second'
meta:
  nested: x
---
# Body
`;

describe("frontmatter", () => {
  const fm = parseFrontmatter(DOC)!;
  const value = (key: string) => fm.fields.find((f) => f.key === key)!;
  const src = (v: { from: number; to: number }) => DOC.slice(v.from, v.to);

  it("reads keys, scalars, lists and the rest", () => {
    expect(fm.to).toBe(DOC.indexOf("\n# Body"));
    expect(fm.fields.map((f) => `${f.key}:${f.kind}`)).toEqual([
      "title:text",
      "quoted:text",
      "single:text",
      "empty:text",
      "draft:bool",
      "tags:list",
      "aliases:list",
      "meta:raw",
    ]);
    expect(value("title").values[0].text).toBe("My note");
    expect(src(value("title").values[0])).toBe("My note");
    expect(value("quoted").values[0].text).toBe('a "b" c');
    expect(src(value("quoted").values[0])).toBe('"a \\"b\\" c"');
    expect(value("single").values[0].text).toBe("it's");
    expect(value("tags").values.map((v) => v.text)).toEqual(["one", "two, three"]);
    expect(value("aliases").values.map((v) => v.text)).toEqual(["first", "second"]);
    expect(value("meta").values[0].text).toBe("nested: x");
  });

  it("is only a block at the very top", () => {
    expect(parseFrontmatter("# x\n---\na: 1\n---\n")).toBeNull();
    expect(parseFrontmatter("---\na: 1\n")).toBeNull();
    expect(parseFrontmatter("---\r\na: 1\r\n---\r\n")?.fields[0].values[0].text).toBe("1");
  });

  it("writes values back as YAML that reads the same", () => {
    const title = value("title").values[0];
    expect(writeValue("Other", title, false)).toBe("Other");
    expect(writeValue("a: b", title, false)).toBe('"a: b"');
    expect(writeValue("true", title, false)).toBe('"true"');
    expect(writeValue('say "hi"', value("quoted").values[0], false)).toBe('"say \\"hi\\""');
    expect(writeValue("x, y", value("tags").values[0], true)).toBe('"x, y"');
    expect(writeValue("it's", value("single").values[0], false)).toBe("'it''s'");
    // An empty value gets the space after `key:`.
    const empty = value("empty").values[0];
    expect(src(empty)).toBe("");
    expect(writeValue("x", empty, false)).toBe(" x");
    expect(writeValue("", title, false)).toBe("");
  });
});
