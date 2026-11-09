import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat();
}

describe("test UI session fake guard", () => {
  it("no production module imports test-ui-session", async () => {
    const dirs = [join(root, "packages"), join(root, "bin", "src")];
    const files = (await Promise.all(dirs.map(sourceFiles))).flat();
    const production = files.filter((path) => {
      const rel = path.replaceAll("\\", "/");
      return (
        !rel.endsWith(".test.ts") &&
        !rel.endsWith("/test-ui-session.ts") &&
        !rel.includes("/test-support/")
      );
    });
    const offenders = await Promise.all(
      production.map(async (path) =>
        (await readFile(path, "utf8")).match(/test-ui-session/) ? path : null,
      ),
    );
    expect(offenders.filter(Boolean)).toEqual([]);
  });
});
