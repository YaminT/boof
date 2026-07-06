import { defineConfig } from "tsup";

// Bundle the Electron main + preload as self-contained CommonJS so Electron can
// load them directly. We inline the @boof-runner/* workspace source and the server's
// runtime deps (hono is ESM, gray-matter is CJS — esbuild normalizes both into
// the CJS bundle). electron and the optional native fsevents stay external.
export default defineConfig({
  entry: { main: "src/main.ts", preload: "src/preload.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node20",
  clean: true,
  dts: false,
  noExternal: [/^@boof-runner\//, "hono", "@hono/node-server", "chokidar", "gray-matter", "zod"],
  external: ["electron", "fsevents"],
});
