import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name === "node_modules" || entry.name === "dist") return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat();
}

describe("fake n8n guard", () => {
  it("no production module imports test-support/fake-n8n", async () => {
    const files = (
      await Promise.all([join(root, "packages"), join(root, "bin", "src")].map(sourceFiles))
    ).flat();
    const production = files.filter((path) => {
      const rel = path.replaceAll("\\", "/");
      return !rel.endsWith(".test.ts") && !rel.includes("/test-support/");
    });
    const offenders = await Promise.all(
      production.map(async (path) =>
        (await readFile(path, "utf8")).match(/fake-n8n/) ? path : null,
      ),
    );
    expect(offenders.filter(Boolean)).toEqual([]);
  });
});
