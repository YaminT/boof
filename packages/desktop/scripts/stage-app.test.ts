import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = resolve(__dirname, "../build/app");

async function walk(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(path, entry.name);
    files.push(fullPath);
    if (entry.isDirectory()) files.push(...(await walk(fullPath)));
  }
  return files;
}

describe("staged desktop app", () => {
  it("contains no Claude Agent SDK files or Claude binary", async () => {
    if (!existsSync(app)) return;
    const paths = await walk(app);
    for (const path of paths) {
      expect(path).not.toMatch(/claude-agent-sdk|@anthropic-ai/i);
      if (/^claude(?:\.exe)?$/i.test(path.split(/[\\/]/).at(-1)!)) {
        throw new Error(`unexpected Claude binary in staged app: ${path}`);
      }
    }
    const main = join(app, "main.js");
    if (existsSync(main)) {
      const contents = await readFile(main, "utf8");
      expect(contents).not.toContain("@anthropic-ai/claude-agent-sdk-linux-x64");
      expect(contents).not.toContain("ProcessTransport");
    }
  });
});
