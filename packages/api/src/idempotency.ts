import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataRootPaths } from "@boof-runner/shared";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** A stored response, replayed for a repeated `Idempotency-Key`. */
export interface IdempotentRecord {
  /** Hash of the request input: the same key with other input is a conflict. */
  fingerprint: string;
  status: number;
  body: unknown;
  etag?: string;
  created: number;
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

  /** Hashes an upload's bytes directly: no JSON copy of a (possibly large) binary body. */
  static fingerprintUpload(file: { name: string; type: string; bytes: Uint8Array }): string {
    return createHash("sha256")
      .update(`${file.name}\0${file.type}\0`)
      .update(file.bytes)
      .digest("hex");
  }

  private path(principal: string, op: string, key: string): string {
    return join(this.dir, `${sha(`${principal}\0${op}\0${key}`)}.json`);
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
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      this.path(principal, op, key),
      JSON.stringify({ ...rec, created: this.now() }),
      "utf8",
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
      const path = join(this.dir, name);
      try {
        const rec = JSON.parse(await readFile(path, "utf8")) as IdempotentRecord;
        if (this.now() - rec.created < this.ttlMs) continue;
      } catch {
        /* corrupt: drop it */
      }
      await rm(path, { force: true });
      removed += 1;
    }
    return removed;
  }
}
