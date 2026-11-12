import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../tsup.config.ts";

type OnLoad = (args: { path: string }) => { contents: string };

async function handlers(): Promise<Map<string, OnLoad>> {
  const found = new Map<string, OnLoad>();
  const plugins = (config as { esbuildPlugins?: Array<{ setup: (build: unknown) => void }> })
    .esbuildPlugins!;
  for (const plugin of plugins) {
    plugin.setup({
      onLoad: (opts: { filter: RegExp }, fn: OnLoad) => found.set(String(opts.filter), fn),
    });
  }
  return found;
}

describe("desktop bundle plugin", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF (a Windows checkout)", "\r\n"],
  ])("rewrites the sandbox module file lookup with %s line endings", async (_name, eol) => {
    const dir = await mkdtemp(join(tmpdir(), "boof-tsup-"));
    try {
      const file = join(dir, "backend-linux.ts");
      const source = [
        "function sandboxModuleFile(): string {",
        "  // cjs-bundle-filename",
        '  return typeof __filename === "string" && __filename.length > 0',
        "    ? __filename",
        "    : fileURLToPath(import.meta.url);",
        "}",
        "export const after = 1;",
      ].join(eol);
      await writeFile(file, source);
      const load = [...(await handlers())].find(([filter]) => filter.includes("backend-linux"))![1];
      const out = load({ path: file }).contents;
      expect(out).toContain("return __filename;");
      expect(out).not.toContain("import.meta.url");
      expect(out).toContain("export const after = 1;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
