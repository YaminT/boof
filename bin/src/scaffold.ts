import { mkdir, stat, writeFile } from "node:fs/promises";
import { defaultSettings, dataPaths, SettingsStore, TaskStore } from "@boof-runner/shared";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the data root exists with all status directories, commands/, and a
 * default settings.json. Existing data is preserved (cli-packaging spec).
 */
export async function scaffoldDataRoot(root: string): Promise<{ created: boolean }> {
  const paths = dataPaths(root);
  const settingsExisted = await exists(paths.settings);

  const store = new TaskStore(root);
  await store.ensureDirs(); // status dirs + commands/ (mkdir recursive = idempotent)
  await mkdir(paths.commands, { recursive: true });

  if (!settingsExisted) {
    const settings = new SettingsStore(root);
    // Default workingDirectory to the current project directory.
    await settings.save(defaultSettings(process.cwd()));
    // Seed a starter command template so the Command tab isn't empty.
    await writeFile(
      `${paths.commands}/secure-feature.md`,
      "---\nid: secure-feature\nname: Secure feature\n---\n\nFollow secure-by-default practices: validate inputs, avoid secrets in code, add tests.\n",
      "utf8",
    );
  }

  return { created: !settingsExisted };
}
