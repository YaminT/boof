import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { lockedAtomicWrite } from "./atomic.js";
import type { ExternalRunResult } from "./external-step-types.js";
import { dataRootPaths } from "./paths.js";

export const EXTERNAL_RUN_ID = /^xr-[0-9a-f]{32}$/;
export const EXTERNAL_RUN_TOKEN_PREFIX = "bxs_";

export interface ExternalRunRecord {
  runId: string;
  tokenHash: string;
  projectId: string;
  taskId: string;
  stepId: string;
  kind: "step" | "check";
  startedAt: string;
  expiresAt: string;
}

const RecordSchema = z.object({
  runId: z.string().regex(EXTERNAL_RUN_ID),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  projectId: z.string(),
  taskId: z.string(),
  stepId: z.string(),
  kind: z.enum(["step", "check"]),
  startedAt: z.string(),
  expiresAt: z.string(),
});

const ResultSchema = z.strictObject({
  status: z.enum(["ok", "failed"]),
  report: z.string(),
  summary: z.string().optional(),
  receivedAt: z.string(),
});

const DAY_MS = 24 * 3600_000;
const STRAY_CLOSED_MS = 3600_000;
const TOLERATED = new Set(["ENOENT", "EPERM", "ENOTSUP", "EOPNOTSUPP"]);

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

/**
 * Single-use run records for external (n8n) steps, one set of files per run in
 * `<data>/external-runs/` (folder 0700, files 0600):
 * `<runId>.json` open record, `<runId>.closed` after the closing rename, `<runId>.result.json`.
 * The record keeps only sha256(token). `rename(.json → .closed)` is the single arbiter between
 * a callback, a replay, a timeout and a stop.
 */
export class ExternalRunStore {
  private readonly dir: string;

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = dataRootPaths(root).externalRuns;
  }

  private p(runId: string, ext: ".json" | ".closed" | ".result.json"): string {
    return join(this.dir, runId + ext);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      await chmod(this.dir, 0o700);
    } catch (err) {
      if (!TOLERATED.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
    }
  }

  async open(input: {
    projectId: string;
    taskId: string;
    stepId: string;
    kind: "step" | "check";
    ttlMs: number;
  }): Promise<{ runId: string; token: string; expiresAt: string }> {
    await this.ensureDir();
    const runId = "xr-" + randomBytes(16).toString("hex");
    const token = EXTERNAL_RUN_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const startedAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + input.ttlMs).toISOString();
    const record: ExternalRunRecord = {
      runId,
      tokenHash: sha256(token).toString("hex"),
      projectId: input.projectId,
      taskId: input.taskId,
      stepId: input.stepId,
      kind: input.kind,
      startedAt,
      expiresAt,
    };
    await lockedAtomicWrite(this.p(runId, ".json"), JSON.stringify(record), { mode: 0o600 });
    return { runId, token, expiresAt };
  }

  /** The open record when `token` matches it and it has not expired; null otherwise. Never throws. */
  async verify(runId: string, token: string | undefined): Promise<ExternalRunRecord | null> {
    try {
      if (!EXTERNAL_RUN_ID.test(runId)) return null;
      if (typeof token !== "string" || !token.startsWith(EXTERNAL_RUN_TOKEN_PREFIX)) return null;
      const parsed = RecordSchema.safeParse(
        JSON.parse(await readFile(this.p(runId, ".json"), "utf8")),
      );
      if (!parsed.success || parsed.data.runId !== runId) return null;
      const rec = parsed.data;
      const want = Buffer.from(rec.tokenHash, "hex");
      const got = sha256(token);
      if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
      if (!(this.now() <= Date.parse(rec.expiresAt))) return null;
      return rec;
    } catch {
      return null;
    }
  }

  /** The one arbiter: true when this caller closed the open record. */
  private async close(runId: string): Promise<boolean> {
    if (!EXTERNAL_RUN_ID.test(runId)) return false;
    try {
      await rename(this.p(runId, ".json"), this.p(runId, ".closed"));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  /** Close the run and store its result. False when it was already closed (replay, cancel, other callback). */
  async complete(runId: string, result: Omit<ExternalRunResult, "receivedAt">): Promise<boolean> {
    if (!(await this.close(runId))) return false;
    const full: ExternalRunResult = { ...result, receivedAt: new Date(this.now()).toISOString() };
    await lockedAtomicWrite(this.p(runId, ".result.json"), JSON.stringify(full), { mode: 0o600 });
    await rm(this.p(runId, ".closed"), { force: true });
    return true;
  }

  /** Close the run without a result (timeout, stop). False when a callback closed it first. */
  async cancel(runId: string): Promise<boolean> {
    if (!(await this.close(runId))) return false;
    await rm(this.p(runId, ".closed"), { force: true });
    return true;
  }

  async result(runId: string): Promise<ExternalRunResult | null> {
    if (!EXTERNAL_RUN_ID.test(runId)) return null;
    let text: string;
    try {
      text = await readFile(this.p(runId, ".result.json"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const parsed = ResultSchema.safeParse(json);
    if (!parsed.success) {
      // Never quote the file: it holds an n8n report.
      console.error(`external run ${runId}: result file is corrupt`);
      return null;
    }
    return parsed.data;
  }

  /** Delete the result after the runner used it. */
  async discard(runId: string): Promise<void> {
    if (!EXTERNAL_RUN_ID.test(runId)) return;
    await rm(this.p(runId, ".result.json"), { force: true });
  }

  /**
   * Delete open records and results older than expiresAt + 24 h (a result is dated by its
   * `receivedAt`, which is never later than its run's expiry) and stray `.closed` files older
   * than 1 h. Returns the count.
   */
  async prune(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
    const now = this.now();
    let count = 0;
    const drop = async (name: string): Promise<void> => {
      await rm(join(this.dir, name), { force: true });
      count++;
    };
    for (const name of names) {
      const m = /^(xr-[0-9a-f]{32})(\.json|\.closed|\.result\.json)$/.exec(name);
      if (!m) continue;
      const file = join(this.dir, name);
      try {
        if (m[2] === ".closed") {
          if (now - (await stat(file)).mtimeMs > STRAY_CLOSED_MS) await drop(name);
          continue;
        }
        const raw = JSON.parse(await readFile(file, "utf8")) as {
          expiresAt?: unknown;
          receivedAt?: unknown;
        };
        const at = Date.parse(String(m[2] === ".json" ? raw.expiresAt : raw.receivedAt));
        const dead = Number.isNaN(at)
          ? now - (await stat(file)).mtimeMs > DAY_MS
          : now > at + DAY_MS;
        if (dead) await drop(name);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        // Unreadable or corrupt: age it by mtime.
        try {
          if (now - (await stat(file)).mtimeMs > DAY_MS) await drop(name);
        } catch {
          /* gone */
        }
      }
    }
    return count;
  }
}
