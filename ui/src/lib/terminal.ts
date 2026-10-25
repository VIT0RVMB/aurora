// xterm.js wrapper. Loaded on demand (dynamic import) so an app with no
// sessions open never pays for the terminal code.
import { FitAddon } from "@xterm/addon-fit";
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

/** Builds the xterm theme from the design tokens, so terminals follow `:theme`. */
export function readTheme(): ITheme {
  const v = cssVar;
  // A see-through window (Preferences) shows the body's tint behind the text.
  const clear = document.documentElement.classList.contains("translucent");
  return {
    background: clear ? "rgba(0, 0, 0, 0)" : v("--bg"),
    foreground: v("--fg"),
    cursor: v("--cursor"),
    cursorAccent: v("--bg"),
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
    const cellH = parseFloat(cssVar("--cell-h")) || 20;
    const fontFamily = cssVar("--font-mono") || "monospace";
    const fontSize = fittedFontSize(base, measureAdvance(fontFamily), window.devicePixelRatio || 1);
    // Rows stay on the app's cell grid.
    return { fontFamily, fontSize, lineHeight: cellH / fontSize };
  };
  const term = new Terminal({
    ...font(),
    theme: readTheme(),
    allowTransparency: true,
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: false,
    macOptionIsMeta: true,
    drawBoldTextInBrightColors: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.onData(o.onData);
  term.onResize(({ cols, rows }) => o.onResize(cols, rows));

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
