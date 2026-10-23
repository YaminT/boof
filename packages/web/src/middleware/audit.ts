import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { dataRootPaths, type SecuritySettings } from "@boof-runner/shared";

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Fields recorded for a task-creating prompt: a hash and length, never the text. */
export function promptFingerprint(prompt: string): { promptSha256: string; promptLength: number } {
  return {
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    promptLength: prompt.length,
  };
}

/**
 * Append one JSON line per /api request to <data>/audit/<YYYY-MM-DD>.jsonl.
 * Records who, what, outcome and timing. Never request bodies, prompts or keys.
 * Placed outermost so rejected requests (401/403/429) are logged too.
 */
export function audit(opts: {
  root: string;
  security: () => Promise<SecuritySettings>;
  now?: () => number;
}): MiddlewareHandler {
  const now = opts.now ?? Date.now;
  const dir = dataRootPaths(opts.root).audit;
  return async (c, next) => {
    const start = now();
    try {
      await next();
    } finally {
      try {
        const { audit: cfg } = await opts.security();
        if (cfg.enabled) {
          const principal = c.get("principal");
          const id = c.req.param("id");
          const name = c.req.param("name");
          const project = c.req.param("pid");
          const line = {
            ts: new Date(start).toISOString(),
            principal: principal?.id ?? "anonymous",
            kind: principal?.kind ?? "anonymous",
            action: `${c.req.method} ${c.req.routePath}`,
            ...(project ? { project } : {}),
            ...(id ? { target: name ? `${id}/${name}` : id } : {}),
            status: c.res.status,
            ms: now() - start,
            ip: c.get("peerAddress") ?? null,
            ...c.get("auditExtra"),
          };
          await mkdir(dir, { recursive: true });
          await appendFile(
            join(dir, `${new Date(start).toISOString().slice(0, 10)}.jsonl`),
            JSON.stringify(line) + "\n",
            "utf8",
          );
        }
      } catch (err) {
        console.error("audit write failed", err);
      }
    }
  };
}

/** Delete daily audit files older than `retentionDays`. Returns the removed file names. */
export async function pruneAudit(
  root: string,
  retentionDays: number,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const dir = dataRootPaths(root).audit;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const cutoff = new Date(nowMs - retentionDays * 86_400_000).toISOString().slice(0, 10);
  const removed: string[] = [];
  for (const name of names) {
    const m = DAY_FILE.exec(name);
    if (m && m[1] < cutoff) {
      await rm(join(dir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}
