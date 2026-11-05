import { defineConfig } from "tsup";

// Bundle the @boof/* workspace packages into the CLI so the published bin is
// self-contained and runnable via node/npx without TS source resolution.
export default defineConfig({
  entry: ["src/boof-runner.ts"],
  format: ["esm"],
  clean: true,
  dts: false,
  // Inline only the @boof/* workspace source; keep third-party libs external so
  // they load from node_modules at runtime (avoids bundling CJS dynamic-require
  // libs like gray-matter/chokidar into the ESM bundle).
  noExternal: [/^@boof\//],
  external: [
    "gray-matter",
    "zod",
    "chokidar",
    "hono",
    "@hono/node-server",
    "@anthropic-ai/claude-agent-sdk",
  ],
  banner: { js: "#!/usr/bin/env node" },
});
