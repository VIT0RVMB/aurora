export interface Segment {
  text: string;
  hit: boolean;
}

/** Splits `text` into runs, marking the UTF-16 positions in `indices` as hits. */
export function segmentsFromIndices(text: string, indices: readonly number[]): Segment[] {
  const set = new Set(indices);
  const out: Segment[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i], hit });
  }
  return out;
}

/** Splits `text` by sorted, non-overlapping `[start, end)` UTF-16 ranges. */
export function segmentsFromRanges(text: string, ranges: readonly [number, number][]): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const [a, b] of ranges) {
    if (a < pos || b <= a) continue;
    if (a > pos) out.push({ text: text.slice(pos, a), hit: false });
    out.push({ text: text.slice(a, b), hit: true });
    pos = b;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}
