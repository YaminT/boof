import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { dataRootPaths } from "./paths.js";
import { SettingsStore, securitySettings } from "./settings.js";

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Append one JSON line to `<data>/audit/<YYYY-MM-DD>.jsonl` (the day of `line.ts`). */
export async function appendAuditLine(
  root: string,
  line: { ts: string; [key: string]: unknown },
): Promise<void> {
  const dir = dataRootPaths(root).audit;
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${line.ts.slice(0, 10)}.jsonl`), JSON.stringify(line) + "\n", "utf8");
}

export interface AuditedOperation {
  principal: { id: string; kind: string };
  /** `mcp:<tool>` for MCP, `cli:<operation>` for the generated CLI. */
  action: string;
  /** The surface that is not the web server: `stdio-mcp` or `cli`. */
  via: "stdio-mcp" | "cli";
  project?: string;
  ok: boolean;
  /** The error code when `ok` is false. */
  code?: string;
  ms: number;
  /** Start time in ms since the epoch (default now). */
  at?: number;
}

/**
 * One audit line for an operation that did not come through the web server (stdio MCP, the
 * generated CLI), subject to the same `security.audit` settings as the web middleware. It carries
 * who (principal id and kind), what (`action`), where (`project`), the outcome and the timing:
 * never arguments, prompts, bodies or keys. Never throws, so auditing cannot fail the operation.
 */
export async function auditOperation(root: string, op: AuditedOperation): Promise<void> {
  try {
    const security = securitySettings(await new SettingsStore(root).load());
    if (!security.audit.enabled) return;
    await appendAuditLine(root, {
      ts: new Date(op.at ?? Date.now()).toISOString(),
      principal: op.principal.id,
      kind: op.principal.kind,
      action: op.action,
      via: op.via,
      ...(op.project ? { project: op.project } : {}),
      outcome: op.ok ? "ok" : "error",
      ...(op.ok || !op.code ? {} : { error: op.code }),
      ms: op.ms,
    });
  } catch (err) {
    console.error("audit write failed", err);
  }
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
    if (m && m[1]! < cutoff) {
      await rm(join(dir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}
