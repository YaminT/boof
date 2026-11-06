import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const rootDir = dirname(fileURLToPath(import.meta.url));

// UI dev server proxies /api to the running Boof Runner server; build emits to ui/dist
// which the Hono server serves in production.
export default defineConfig({
  root: rootDir,
  plugins: [
    react(),
    tailwindcss(),
    {
      // The server injects <base> in production; the dev server needs one so /p/x/tasks still
      // reaches the /api proxy.
      name: "boof-dev-base",
      apply: "serve",
      transformIndexHtml: (html: string) => html.replace("<head>", '<head>\n    <base href="/" />'),
    },
  ],
  resolve: {
    alias: { "@": join(rootDir, "src") },
  },
  server: {
    port: 5319,
    proxy: {
      "/api": "http://127.0.0.1:4319",
    },
  },
  // Relative asset URLs: the built UI works at / and behind a reverse-proxy path prefix
  // (for example https://example.com/boof/ with nginx stripping /boof).
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
