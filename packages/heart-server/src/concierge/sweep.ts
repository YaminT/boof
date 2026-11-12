import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Removes `<root>/concierge/<project>/turn-*` directories left by a crashed server. Each holds a
 * per-turn MCP config with a bearer token; the token is dead after a restart, so this is hygiene.
 */
export async function sweepConciergeTurns(root: string): Promise<number> {
  let removed = 0;
  const base = join(root, "concierge");
  const projects = await readdir(base).catch(() => [] as string[]);
  for (const project of projects) {
    const entries = await readdir(join(base, project)).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!/^turn-[0-9a-f]+$/.test(entry)) continue;
      await rm(join(base, project, entry), { recursive: true, force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}
