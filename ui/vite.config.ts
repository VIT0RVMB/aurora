import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

/**
 * xterm's WebGL renderer (0.19, still in 0.20 betas) decides a cell has its
 * own background by testing the whole bg word, which also holds the dim,
 * italic, protected and overline bits. Dim placeholders and hints then get a
 * rectangle of the theme background painted fully opaque, which shows as a
 * dark box on a see-through window. Mask the word down to color mode + color.
 * Throws when the code changes, so an upgrade can't drop the fix silently.
 */
function xtermWebglDimFix(): Plugin {
  const from = "f=t.cells[h+ze],I=t.cells[h+qe]";
  const to = "f=t.cells[h+ze]&67108863,I=t.cells[h+qe]";
  return {
    name: "xterm-webgl-dim-fix",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@xterm/addon-webgl/lib/addon-webgl.mjs")) return;
      if (!code.includes(from)) throw new Error("xterm-webgl-dim-fix: pattern not found; recheck after the upgrade");
      return { code: code.replace(from, to), map: null };
    },
  };
}

// Tauri expects a fixed port and no clearing of its own log output.
export default defineConfig({
  plugins: [solid(), xtermWebglDimFix()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // Pre-bundled deps skip plugin transforms; serve the addon as is.
  optimizeDeps: { exclude: ["@xterm/addon-webgl"] },
  build: { target: "es2022", sourcemap: false },
});
