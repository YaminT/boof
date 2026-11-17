import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run on Node (CI) via Vitest. Source stays portable across Bun + Node.
export default defineConfig({
  // The UI imports `@/...` (see packages/facedisk/ui/vite.config.ts); tests that render its components need it.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./packages/facedisk/ui/src", import.meta.url)) },
  },
  test: {
    include: ["packages/**/*.test.ts", "bin/**/*.test.ts"],
    environment: "node",
    globals: false,
    // Windows runners spawn git and child processes several times slower.
    testTimeout: process.platform === "win32" ? 180_000 : 20000,
    hookTimeout: process.platform === "win32" ? 180_000 : 10000,
  },
});
