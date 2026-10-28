// xterm.js wrapper. Loaded on demand (dynamic import) so an app with no
// sessions open never pays for the terminal code.
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { fittedFontSize } from "./cells";

export interface TermHandle {
  /** Moves the terminal into `el` (opening it the first time) and fits it. */
  mount(el: HTMLElement): void;
  fit(): void;
  write(bytes: Uint8Array): void;
  reset(): void;
  focus(): void;
  applyTheme(): void;
  /** Picks up a new font family/size from the tokens and refits. */
  applyFont(): void;
  /** Lines per wheel notch (and five times that with Alt held). */
  setScrollSpeed(lines: number): void;
  size(): { cols: number; rows: number };
  /** Plain text of the whole buffer, scrollback included. */
  text(): string;
  /** Feeds keys as if typed (smoke tests). */
  type(data: string): void;
  readonly opened: boolean;
  dispose(): void;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * `#rgb` / `#rrggbb` as fully transparent `rgba()`, keeping the color.
 * A see-through terminal still needs the real background color: agents ask
 * for it (OSC 11) to tint their panels, and xterm's WebGL renderer paints
 * dim text (`ESC[2m`) over an opaque copy of it. With transparent black,
 * both came out black.
 */
export function clearOf(color: string): string {
  let hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return "rgba(0, 0, 0, 0)";
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, 0)`;
}

/** Builds the xterm theme from the design tokens, so terminals follow `:theme`. */
export function readTheme(): ITheme {
  const v = cssVar;
  // A see-through window (Preferences) shows the body's tint behind the text.
  const clear = document.documentElement.classList.contains("translucent");
  return {
    background: clear ? clearOf(v("--bg-term")) : v("--bg-term"),
    foreground: v("--fg"),
    cursor: v("--cursor"),
    cursorAccent: v("--bg-term"),
    selectionBackground: v("--selection"),
    black: v("--ansi-black"),
    red: v("--ansi-red"),
    green: v("--ansi-green"),
    yellow: v("--ansi-yellow"),
    blue: v("--ansi-blue"),
    magenta: v("--ansi-magenta"),
    cyan: v("--ansi-cyan"),
    white: v("--ansi-white"),
    brightBlack: v("--ansi-bright-black"),
    brightRed: v("--ansi-bright-red"),
    brightGreen: v("--ansi-bright-green"),
    brightYellow: v("--ansi-bright-yellow"),
    brightBlue: v("--ansi-bright-blue"),
    brightMagenta: v("--ansi-bright-magenta"),
    brightCyan: v("--ansi-bright-cyan"),
    brightWhite: v("--ansi-bright-white"),
  };
}

export interface TermOptions {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /** Called once, after the first fit: the right moment to attach. */
  onOpen: () => void;
  scrollSpeed: number;
}

/** Terminal rows are their own height, not the app's `--cell-h`. */
const TERM_LINE_HEIGHT = 1.2;

/** A key that is text of several characters (WebKit's "'s"), not a name like "Enter". */
export function isDeadCommit(key: string): boolean {
  return [...key].length > 1 && !/^[A-Z][A-Za-z0-9]*$/.test(key);
}

function measureAdvance(family: string): number {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return 0;
  ctx.font = `100px ${family}`;
  return ctx.measureText("W").width / 100;
}

export function createTerminal(o: TermOptions): TermHandle {
  // Read from the tokens each time: preferences can change the font live.
  const font = () => {
    const base = parseFloat(cssVar("--font-size")) || 13;
    const fontFamily = cssVar("--font-mono") || "monospace";
    const fontSize = fittedFontSize(base, measureAdvance(fontFamily), window.devicePixelRatio || 1);
    // Cells near 2:1, like other terminals: agents draw pixel art with block
    // characters (Claude Code's mascot), which the app's taller rows stretched.
    return { fontFamily, fontSize, lineHeight: TERM_LINE_HEIGHT };
  };
  const term = new Terminal({
    ...font(),
    theme: readTheme(),
    allowTransparency: true,
    cursorBlink: true,
    scrollback: 10_000,
    // Wheel and trackpad: xterm's default (1 line per notch) feels stuck.
    scrollSensitivity: o.scrollSpeed,
    fastScrollSensitivity: o.scrollSpeed * 5,
    // Needed by the Unicode 11 widths below (`term.unicode`).
    allowProposedApi: true,
    macOptionIsMeta: true,
    drawBoldTextInBrightColors: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Emoji (🤖 🧠 🌿 in agents' status lines) are two cells wide; xterm's
  // default Unicode 6 tables say one, so the next text drew over them.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.onData(o.onData);
  term.onResize(({ cols, rows }) => o.onResize(cols, rows));
  // WebKit dead keys (Brazilian, US International): `'` then `s` commits the
  // `'` through composition, then fires keydown with key "'s" and a keypress
  // for `'`, which xterm sends again, and the `s` arrives as an input event
  // xterm ignores ("let''s"). Skip that keydown/keypress and send the input.
  let deadCommit = false;
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type === "keyup") deadCommit = false;
    else if (ev.type === "keydown") deadCommit = isDeadCommit(ev.key);
    return !deadCommit;
  });
  const onInput = (ev: Event) => {
    const e = ev as InputEvent;
    if (deadCommit && e.inputType === "insertText" && e.data) term.input(e.data, true);
  };

  // Fonts finishing to load or a move to a screen with another pixel density
  // change the metrics: recompute the size and refit.
  const refont = () => {
    Object.assign(term.options, font());
    doFit();
  };
  void document.fonts?.ready.then(refont);
  let dprQuery: MediaQueryList | null = null;
  const watchDpr = () => {
    dprQuery?.removeEventListener("change", onDpr);
    dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprQuery.addEventListener("change", onDpr);
  };
  const onDpr = () => {
    refont();
    watchDpr();
  };
  watchDpr();

  const host = document.createElement("div");
  host.className = "term-host";
  let opened = false;

  const doFit = () => {
    if (!opened || !host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) return;
    try {
      fit.fit();
    } catch {
      // Not measurable yet (hidden); the next resize retries.
    }
  };

  return {
    mount(el) {
      if (host.parentElement !== el) el.replaceChildren(host);
      if (!opened) {
        term.open(host);
        opened = true;
        term.textarea?.addEventListener("input", onInput);
        // WebGL is much faster for agent output; the DOM renderer is the fallback.
        void import("@xterm/addon-webgl")
          .then(({ WebglAddon }) => {
            const gl = new WebglAddon();
            gl.onContextLoss(() => gl.dispose());
            term.loadAddon(gl);
            // The WebGL renderer measures cells itself; fit again with its numbers.
            doFit();
          })
          .catch(() => {});
        doFit();
        o.onOpen();
      } else doFit();
    },
    fit: doFit,
    write: (bytes) => term.write(bytes),
    reset: () => term.reset(),
    focus: () => term.focus(),
    applyTheme: () => (term.options.theme = readTheme()),
    applyFont: refont,
    setScrollSpeed: (lines) => {
      term.options.scrollSensitivity = lines;
      term.options.fastScrollSensitivity = lines * 5;
    },
    size: () => ({ cols: term.cols, rows: term.rows }),
    type: (data) => term.input(data, true),
    text: () => {
      const b = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
      return lines.join("\n");
    },
    get opened() {
      return opened;
    },
    dispose: () => {
      dprQuery?.removeEventListener("change", onDpr);
      term.dispose();
    },
  };
}
