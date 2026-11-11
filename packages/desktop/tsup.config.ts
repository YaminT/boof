import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Bundle the Electron main + preload as self-contained CommonJS so Electron can
// load them directly. We inline the @boof/* workspace source and the server's
// runtime deps (hono is ESM, gray-matter is CJS — esbuild normalizes both into
// the CJS bundle). electron and the optional native fsevents stay external.
export default defineConfig({
  entry: { main: "src/main.ts", preload: "src/preload.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node20",
  clean: true,
  dts: false,
  noExternal: [/^@boof\//, "hono", "@hono/node-server", "chokidar", "gray-matter", "zod"],
  external: ["electron", "fsevents", "@anthropic-ai/claude-agent-sdk"],
  esbuildPlugins: [
    {
      // The runner falls back to import.meta.url when __filename is missing.
      // That token is empty in this CJS bundle and esbuild warns. __filename is
      // always set here, so drop the fallback before the bundle is parsed.
      name: "cjs-filename-for-agent-sdk",
      setup(build) {
        build.onLoad({ filter: /[/\\]claude-agent-sdk\.ts$/ }, (args) => {
          const source = readFileSync(args.path, "utf8");
          const fallback = 'typeof __filename === "string" ? __filename : import.meta.url';
          if (!source.includes(fallback)) {
            throw new Error("cjs-filename-for-agent-sdk: import.meta fallback not found");
          }
          return { contents: source.replace(fallback, "__filename"), loader: "ts" };
        });
        build.onLoad({ filter: /[/\\]backend-linux\.ts$/ }, (args) => {
          const source = readFileSync(args.path, "utf8");
          if (!source.includes("// cjs-bundle-filename")) {
            throw new Error("cjs-filename-for-agent-sdk: sandbox module marker not found");
          }
          const rewritten = "function sandboxModuleFile(): string {\n  return __filename;\n}";
          const contents = source.replace(
            /function sandboxModuleFile\(\): string \{\n {2}\/\/ cjs-bundle-filename\n[\s\S]*?\n\}/,
            rewritten,
          );
          if (!contents.includes(rewritten)) {
            throw new Error("cjs-filename-for-agent-sdk: sandbox module was not rewritten");
          }
          return { contents, loader: "ts" };
        });
      },
    },
  ],
});
