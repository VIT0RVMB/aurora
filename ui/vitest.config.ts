import { defineConfig } from "vitest/config";

// Tests cover pure modules in src/lib; they need neither the DOM nor the Solid plugin
// (which would otherwise switch the environment to jsdom).
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
