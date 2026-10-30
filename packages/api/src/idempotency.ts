import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, dataRootPaths } from "@boof-runner/shared";
import { OpError } from "./errors.js";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** A `.pending` marker older than this is a crashed request: it is ignored and replaced. */
export const PENDING_TTL_MS = 60_000;

/** A stored response, replayed for a repeated `Idempotency-Key`. */
export interface IdempotentRecord {
  /** Hash of the request input: the same key with other input is a conflict. */
  fingerprint: string;
  status: number;
  body: unknown;
  etag?: string;
  created: number;
}

export interface IdempotentOutcome {
  record: IdempotentRecord;
  /** True when the record came from an earlier request with this key. */
  replayed: boolean;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** `<data>/idempotency/<sha256(principal, operation, key)>.json`, kept 24 hours. */
export class IdempotencyStore {
  private readonly dir: string;

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = IDEMPOTENCY_TTL_MS,
  ) {
    this.dir = dataRootPaths(root).idempotency;
  }

  static fingerprint(input: unknown): string {
    return sha(JSON.stringify(input));
  }

  /**
   * Hashes an upload's bytes directly: no JSON copy of a (possibly large) binary body. `rest` is
   * the other input (path params): the same file sent to another task is another request.
   */
  static fingerprintUpload(
    file: { name: string; type: string; bytes: Uint8Array },
    rest: unknown,
  ): string {
    return createHash("sha256")
      .update(`${file.name}\0${file.type}\0`)
      .update(file.bytes)
      .update(`\0${JSON.stringify(rest)}`)
      .digest("hex");
  }

  private path(principal: string, op: string, key: string): string {
    return join(this.dir, `${sha(`${principal}\0${op}\0${key}`)}.json`);
  }

  /** @internal The in-progress marker of a key (exposed for tests). */
  pendingPath(principal: string, op: string, key: string): string {
    return this.path(principal, op, key).replace(/\.json$/, ".pending");
  }

  /** Callers of one path queue here, so the second sees the first's stored record. */
  private readonly inflight = new Map<string, Promise<unknown>>();

  /**
   * Run `execute` once per (principal, op, key). Callers in this process are chained; a
   * `.pending` marker (created exclusively, so two processes cannot both claim the key) makes
   * another process answer 409 while this one runs. A crash leaves a marker that expires after
   * `PENDING_TTL_MS`. Failures store nothing.
   */
  async withKey(
    principal: string,
    op: string,
    key: string,
    fingerprint: string,
    execute: () => Promise<Omit<IdempotentRecord, "created" | "fingerprint">>,
  ): Promise<IdempotentOutcome> {
    const path = this.path(principal, op, key);
    const prev = this.inflight.get(path) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(() => this.locked(principal, op, key, fingerprint, execute));
    this.inflight.set(path, run);
    try {
      return await run;
    } finally {
      if (this.inflight.get(path) === run) this.inflight.delete(path);
    }
  }

  private async locked(
    principal: string,
    op: string,
    key: string,
    fingerprint: string,
    execute: () => Promise<Omit<IdempotentRecord, "created" | "fingerprint">>,
  ): Promise<IdempotentOutcome> {
    const stored = await this.get(principal, op, key);
    if (stored) {
      if (stored.fingerprint !== fingerprint) {
        throw new OpError(
          409,
          "This Idempotency-Key was used with a different request",
          "idempotency_conflict",
        );
      }
      return { record: stored, replayed: true };
    }
    const marker = this.pendingPath(principal, op, key);
    const claim = JSON.stringify({ fingerprint, created: this.now() });
    for (let attempt = 0; ; attempt++) {
      try {
        await atomicWrite(marker, claim, { exclusive: true });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (attempt > 0 || !(await this.pendingStale(marker))) {
          throw new OpError(
            409,
            "This Idempotency-Key is being processed by another request; retry in a moment",
            "conflict",
          );
        }
        await rm(marker, { force: true }); // a crashed request: take the key over
      }
    }
    try {
      const out = await execute();
      const record: IdempotentRecord = { ...out, fingerprint, created: this.now() };
      await this.put(principal, op, key, record);
      return { record, replayed: false };
    } finally {
      await rm(marker, { force: true });
    }
  }

  /** True when the marker is old or unreadable (a crash), false when it is still fresh. */
  private async pendingStale(marker: string): Promise<boolean> {
    try {
      const { created } = JSON.parse(await readFile(marker, "utf8")) as { created: number };
      return !(this.now() - created < PENDING_TTL_MS);
    } catch {
      return true;
    }
  }

  async get(principal: string, op: string, key: string): Promise<IdempotentRecord | null> {
    const path = this.path(principal, op, key);
    try {
      const rec = JSON.parse(await readFile(path, "utf8")) as IdempotentRecord;
      if (this.now() - rec.created < this.ttlMs) return rec;
      await rm(path, { force: true });
    } catch {
      /* absent or unreadable */
    }
    return null;
  }

  async put(principal: string, op: string, key: string, rec: Omit<IdempotentRecord, "created">) {
    await atomicWrite(
      this.path(principal, op, key),
      JSON.stringify({ ...rec, created: this.now() }),
    );
  }

  /** Delete expired records. Returns how many were removed. */
  async prune(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (name.startsWith(".")) continue; // another writer's temp file
      const path = join(this.dir, name);
      try {
        const rec = JSON.parse(await readFile(path, "utf8")) as IdempotentRecord;
        const ttl = name.endsWith(".pending") ? PENDING_TTL_MS : this.ttlMs;
        if (this.now() - rec.created < ttl) continue;
      } catch {
        /* corrupt: drop it */
      }
      await rm(path, { force: true });
      removed += 1;
    }
    return removed;
  }
}
