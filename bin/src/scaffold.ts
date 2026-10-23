import { mkdir, writeFile } from "node:fs/promises";
import { dataRootPaths, migrateDataRoot, type MigrationResult } from "@boof-runner/shared";

/**
 * Ensure the data root exists in layout v2: migrate a v1 root first (before any store opens),
 * then make sure projects/ and commands/ exist and a fresh root gets default settings (no
 * projects) and a starter command template. Existing data is preserved (cli-packaging spec).
 */
export async function scaffoldDataRoot(
  root: string,
): Promise<{ created: boolean; migration: MigrationResult }> {
  const paths = dataRootPaths(root);
  await mkdir(root, { recursive: true });
  const migration = await migrateDataRoot(root);
  await mkdir(paths.projects, { recursive: true });
  await mkdir(paths.commands, { recursive: true });

  const created = migration.kind === "fresh";
  if (created) {
    // Seed a starter command template so the Command tab isn't empty.
    await writeFile(
      `${paths.commands}/secure-feature.md`,
      "---\nid: secure-feature\nname: Secure feature\n---\n\nFollow secure-by-default practices: validate inputs, avoid secrets in code, add tests.\n",
      "utf8",
    );
  }
  return { created, migration };
}
