export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Cmd on macOS, Ctrl elsewhere. */
export function isMod(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

export const modLabel = isMac ? "⌘" : "Ctrl+";

export function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLElement && (el.isContentEditable || !!el.closest(".cm-editor"));
}
