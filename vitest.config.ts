import { defineConfig } from "vitest/config";

// Tests run on Node (CI) via Vitest. Source stays portable across Bun + Node.
export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "bin/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 20000,
  },
});
