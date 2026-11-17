import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAnthropicApiKey, PROVIDER } from "./accounts-store.js";

/** Where better-ccflare keeps its database by default. */
export const defaultCcflareDb = (home: string = homedir()): string =>
  join(home, ".config", "better-ccflare", "better-ccflare.db");

/** An API-key account found in a better-ccflare database. The key stays inside this module's callers. */
export interface CcflareCandidate {
  name: string;
  apiKey: string;
}

export interface CcflareSkip {
  name: string;
  provider: string;
  reason: string;
}

export interface CcflareScan {
  candidates: CcflareCandidate[];
  skipped: CcflareSkip[];
}

/** What an import reports: counts and reasons only, never a key. */
export interface CcflareImportResult {
  imported: { name: string }[];
  skipped: CcflareSkip[];
}

export class CcflareImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CcflareImportError";
  }
}

const SUBSCRIPTION_REASON =
  "subscription (OAuth) account: boof's pool takes API keys only; it stays in better-ccflare";

function skipReason(provider: string): string {
  if (provider === "anthropic") return SUBSCRIPTION_REASON;
  if (provider === "codex") return "Codex/OpenAI accounts are not supported by boof's pool";
  return `provider "${provider}" is not supported by boof's pool (Anthropic API keys only)`;
}

/** Run `fn` with the one-line node:sqlite ExperimentalWarning dropped (this call only). */
async function withoutSqliteWarning<T>(fn: () => Promise<T> | T): Promise<T> {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const name = typeof warning === "string" ? (rest[0] as string | undefined) : warning.name;
    const text = typeof warning === "string" ? warning : warning.message;
    if (name === "ExperimentalWarning" && /sqlite/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await fn();
  } finally {
    process.emitWarning = original;
  }
}

/**
 * Read the accounts of a better-ccflare database, read-only (the file is never changed; no
 * journal or lock file is created next to it). `claude-console-api` accounts with a well-formed
 * key are candidates; every other account is listed as skipped with the reason.
 */
export async function scanCcflare(dbPath: string): Promise<CcflareScan> {
  if (!existsSync(dbPath)) throw new CcflareImportError(`no better-ccflare database at ${dbPath}`);
  return withoutSqliteWarning(async () => {
    let sqlite: typeof import("node:sqlite");
    try {
      sqlite = await import("node:sqlite");
    } catch {
      throw new CcflareImportError("this Node.js has no node:sqlite; paste the keys by hand");
    }
    let rows: Record<string, unknown>[];
    const db = (() => {
      try {
        return new sqlite.DatabaseSync(dbPath, { readOnly: true });
      } catch {
        throw new CcflareImportError("the better-ccflare database could not be opened");
      }
    })();
    try {
      rows = db
        .prepare("SELECT name, provider, api_key FROM accounts ORDER BY priority, name")
        .all() as Record<string, unknown>[];
    } catch {
      throw new CcflareImportError("the file is not a better-ccflare database");
    } finally {
      db.close();
    }
    const scan: CcflareScan = { candidates: [], skipped: [] };
    for (const row of rows) {
      const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : "account";
      const provider = typeof row.provider === "string" ? row.provider : "unknown";
      if (provider !== PROVIDER) {
        scan.skipped.push({ name, provider, reason: skipReason(provider) });
      } else if (!isAnthropicApiKey(row.api_key)) {
        scan.skipped.push({ name, provider, reason: "it has no valid Anthropic API key" });
      } else {
        scan.candidates.push({ name, apiKey: row.api_key });
      }
    }
    return scan;
  });
}

/** Counts for the prompt, without keeping any key. */
export async function summariseCcflare(
  dbPath: string,
): Promise<{ importable: number; skipped: number }> {
  const scan = await scanCcflare(dbPath);
  return { importable: scan.candidates.length, skipped: scan.skipped.length };
}

/** Import every candidate through `add` (the pool's add). A rejected account is reported, not thrown. */
export async function importCcflare(
  dbPath: string,
  add: (input: { name: string; apiKey: string }) => Promise<unknown>,
): Promise<CcflareImportResult> {
  const scan = await scanCcflare(dbPath);
  const result: CcflareImportResult = { imported: [], skipped: [...scan.skipped] };
  for (const c of scan.candidates) {
    try {
      await add({ name: c.name, apiKey: c.apiKey });
      result.imported.push({ name: c.name });
    } catch (err) {
      // Pool validation messages name the problem, never the key.
      const reason = err instanceof Error ? err.message : "rejected";
      result.skipped.push({ name: c.name, provider: PROVIDER, reason });
    }
  }
  return result;
}
