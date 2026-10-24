import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Tauri expects a fixed port and no clearing of its own log output.
export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", sourcemap: false },
});
