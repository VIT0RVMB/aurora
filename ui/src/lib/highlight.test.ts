import { describe, expect, it } from "vitest";
import { segmentsFromIndices, segmentsFromRanges } from "./highlight";

describe("segments", () => {
  it("groups consecutive indices", () => {
    expect(segmentsFromIndices("src/main.rs", [4, 5, 6, 7])).toEqual([
      { text: "src/", hit: false },
      { text: "main", hit: true },
      { text: ".rs", hit: false },
    ]);
  });
  it("splits by ranges and skips overlaps", () => {
    expect(segmentsFromRanges("main main", [[0, 4], [2, 3], [5, 9]])).toEqual([
      { text: "main", hit: true },
      { text: " ", hit: false },
      { text: "main", hit: true },
    ]);
  });
});
