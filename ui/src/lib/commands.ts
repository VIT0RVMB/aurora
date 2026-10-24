// The command palette is the app's own CLI: `:name arg1 "arg two"`.

export interface ParsedCommand {
  name: string;
  args: string[];
}

export interface Choice {
  value: string;
  description: string;
}

export interface CommandSpec {
  name: string;
  aliases?: string[];
  usage?: string;
  description: string;
  /** Static completions for the first argument. */
  argChoices?: string[];
  /** Completions for the next argument, given the ones already typed; a choice may carry its own description. */
  complete?: (before: string[]) => (string | Choice)[];
}

/** Splits `:name a "b c"` into name + args. Returns null when there is no name. */
export function parseCommand(input: string): ParsedCommand | null {
  const text = input.trim().replace(/^:/, "");
  const tokens: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) tokens.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) tokens.push(cur);
  const [name, ...args] = tokens;
  return name ? { name: name.toLowerCase(), args } : null;
}

export function findCommand<T extends CommandSpec>(specs: T[], name: string): T | undefined {
  return specs.find((s) => s.name === name || s.aliases?.includes(name));
}

export interface Suggestion {
  /** Text the input becomes when the suggestion is accepted. */
  value: string;
  label: string;
  description: string;
}

/** Suggestions for the current input: command names first, then argument choices. */
export function suggest(specs: CommandSpec[], input: string): Suggestion[] {
  const text = input.replace(/^:/, "");
  const space = text.search(/\s/);
  if (space === -1) {
    const q = text.toLowerCase();
    return specs
      .filter((s) => s.name.startsWith(q) || s.aliases?.some((a) => a.startsWith(q)))
      .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)))
      .map((s) => ({
        value: `:${s.name}${s.usage || s.argChoices ? " " : ""}`,
        label: `:${s.name}${s.usage ? ` ${s.usage}` : ""}`,
        description: s.description,
      }));
  }
  const spec = findCommand(specs, text.slice(0, space).toLowerCase());
  if (!spec) return [];
  const parts = text.slice(space).trimStart().split(/\s+/);
  const partial = (parts.pop() ?? "").toLowerCase();
  const choices = spec.complete?.(parts) ?? (parts.length === 0 ? (spec.argChoices ?? []) : []);
  return choices
    .map((c) => (typeof c === "string" ? { value: c, description: spec.description } : c))
    .filter((c) => c.value.toLowerCase().startsWith(partial))
    .map((c) => {
      const line = `:${spec.name} ${[...parts, c.value].join(" ")}`;
      return { value: line, label: line, description: c.description };
    });
}

/**
 * The line Enter runs. A suggestion the user picked (arrows, click) wins, and
 * so does one completing a partial argument (`:theme cat` → `:theme
 * catppuccin-mocha`). Otherwise the typed line runs, so an exact `:q` or a bare
 * `:theme` is not swapped for the first suggestion. `null`: fill the input
 * with the suggestion instead (it still needs an argument).
 */
export function lineToRun(typed: string, s: Suggestion | undefined, picked: boolean, exact: boolean): string | null {
  if (!s || s.value.trim() === typed) return typed;
  const partialArg = /\s\S+$/.test(typed) && s.value.startsWith(typed);
  const partialName = !exact && !typed.includes(" ");
  if (!picked && !partialArg && !partialName) return typed;
  return s.value.endsWith(" ") ? null : s.value;
}

/** Absolute or home-relative paths point at a folder to open; others at a file in the workspace. */
export function isOutsidePath(p: string): boolean {
  return p.startsWith("/") || p.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
}
