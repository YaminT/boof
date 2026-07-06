import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = dirname(fileURLToPath(import.meta.url));

// UI dev server proxies /api to the running Boof Runner server; build emits to ui/dist
// which the Hono server serves in production.
export default defineConfig({
  root: rootDir,
  plugins: [react()],
  server: {
    port: 5319,
    proxy: {
      "/api": "http://127.0.0.1:4319",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
