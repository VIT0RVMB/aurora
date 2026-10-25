// App-level vim mapping: `:` opens Aurora's command line, which falls back to
// vim's own ex commands. The `<Space>` leader is handled by the app's key
// handler, so it works the same in the editor, the tree and the panels.
import { Vim } from "@replit/codemirror-vim";

export const LEADER_KEYS = ["f", "p", "/", "s", "t", "e", "b", "n", "w", "q", "h", "k", "o"] as const;
export type LeaderKey = (typeof LEADER_KEYS)[number];

let installed = false;

export function installVimKeys(h: { palette: () => void }) {
  if (installed) return;
  installed = true;
  Vim.defineAction("auroraPalette", () => h.palette());
  Vim.mapCommand(":", "action", "auroraPalette", {}, { context: "normal" });
}
