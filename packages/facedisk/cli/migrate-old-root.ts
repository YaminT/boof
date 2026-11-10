import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scaffoldDataRoot } from "@boof/heart";

/** Migrate only a 0.3.0 root (schema 2), so a current root's unsafe-path refusals still apply. */
export async function migrateOldRoot(root: string): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as {
      schemaVersion?: unknown;
    };
    if (raw?.schemaVersion !== 2) return;
  } catch {
    return;
  }
  await scaffoldDataRoot(root);
}
