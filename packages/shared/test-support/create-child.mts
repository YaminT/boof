// Child process for project-store tests: runs one ProjectStore.create against a shared data root.
// argv: <root> <startAtMs> <json CreateProjectInput>. Prints one JSON line: { ok, id?, code?, message? }.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectStore } from "../src/project-store.ts";

const [root, startAt, inputJson] = process.argv.slice(2);
const store = new ProjectStore(root, {
  isGitRepo: async (dir) => {
    try {
      await readFile(join(dir, ".git", "HEAD"));
      return true;
    } catch {
      return false;
    }
  },
  initGitRepo: async (dir) => {
    await new Promise((r) => setTimeout(r, 150));
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  },
});
await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
try {
  const p = await store.create(JSON.parse(inputJson));
  console.log(JSON.stringify({ ok: true, id: p.id }));
} catch (err) {
  const e = err as { code?: string; message?: string };
  console.log(JSON.stringify({ ok: false, code: e.code, message: e.message }));
}
