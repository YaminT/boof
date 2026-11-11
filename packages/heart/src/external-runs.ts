import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { lockedAtomicWrite } from "./atomic.js";
import { assertSafeForSecrets } from "./data-root-mode.js";
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
const STRAY_TMP_MS = 3600_000;
const MIN_TTL_MS = 1000;
const MAX_TTL_MS = DAY_MS;

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

/**
 * Single-use run records for external (n8n) steps, one set of files per run in
 * `<data>/external-runs/` (folder 0700, files 0600):
 * `<runId>.json` open record, `<runId>.closed` after the closing claim, `<runId>.result.json`.
 * The record keeps only sha256(token). An exclusive create of `.closed` arbitrates between
 * a callback, a replay, a timeout and a stop.
 */
export class ExternalRunStore {
  private readonly dir: string;

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
    private readonly renameFile: typeof rename = rename,
  ) {
    this.dir = dataRootPaths(this.root).externalRuns;
  }

  private p(runId: string, ext: ".json" | ".closed" | ".result.json"): string {
    return join(this.dir, runId + ext);
  }

  /**
   * The shared layer-1 owner/mode/symlink rules on the data root and `external-runs/`, before
   * every read and write: this folder's integrity is what makes a callback unforgeable. The
   * folder may be missing (nothing opened yet) unless `strict`.
   */
  private async guard(strict = false): Promise<void> {
    await assertSafeForSecrets(this.root, this.root, "directory");
    await assertSafeForSecrets(this.root, this.dir, "directory", { allowMissing: !strict });
  }

  private async ensureDir(): Promise<void> {
    await this.guard(); // refuses a symlinked folder before mkdir/chmod could follow it
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700); // a failure is not ignored: the checker below decides
    await this.guard(true);
  }

  async open(input: {
    projectId: string;
    taskId: string;
    stepId: string;
    kind: "step" | "check";
    ttlMs: number;
  }): Promise<{ runId: string; token: string; expiresAt: string }> {
    if (!(input.ttlMs >= MIN_TTL_MS && input.ttlMs <= MAX_TTL_MS))
      throw new RangeError(`ttlMs must be between ${MIN_TTL_MS} and ${MAX_TTL_MS}`);
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
      await this.guard();
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

  /** True when a task still has an open external run. Errors propagate so recovery can fail closed. */
  async hasOpenForTask(projectId: string, taskId: string): Promise<boolean> {
    await this.guard();
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".result.json")) continue;
      try {
        const parsed = RecordSchema.safeParse(
          JSON.parse(await readFile(this.p(name.slice(0, -5), ".json"), "utf8")),
        );
        if (!parsed.success) throw new Error("invalid external-run record");
        if (parsed.success && parsed.data.projectId === projectId && parsed.data.taskId === taskId)
          return true;
      } catch {
        // A malformed open record cannot prove that no external step is still in flight.
        throw new Error(`cannot inspect external run ${name}`);
      }
    }
    return false;
  }

  /** The one arbiter: true when this caller closed the open record. */
  private async close(runId: string): Promise<boolean> {
    const from = this.p(runId, ".json");
    const to = this.p(runId, ".closed");
    let record: Buffer;
    try {
      record = await readFile(from);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    // Windows can report success for competing renames of the same source, and a retry can
    // overlap complete() restoring .json after a result-write failure. An exclusive create
    // makes the winner explicit; only that caller may remove the open record and return true.
    try {
      await writeFile(to, record, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      await rm(to, { force: true }).catch(() => {});
      throw err;
    }
    try {
      await rm(from);
    } catch (err) {
      await rm(to, { force: true }).catch(() => {});
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    // Prune ages `.closed` from the close time.
    const t = new Date(this.now());
    await utimes(to, t, t).catch(() => {});
    return true;
  }

  /**
   * Close the run and store its result. False when it was already closed (replay, cancel, other
   * callback). The caller must `verify` the token first (this method checks neither token nor
   * expiry) and validate the body before calling, so a bad body never reaches here.
   *
   * A storage failure does not burn the token: the result is written to a temp file first, then
   * the run is closed, then the temp file is moved into place. If any step fails the run is left
   * open (a closed record is renamed back) and the error is thrown, so n8n gets a 5xx and may retry
   * with the same token.
   */
  async complete(runId: string, result: Omit<ExternalRunResult, "receivedAt">): Promise<boolean> {
    if (!EXTERNAL_RUN_ID.test(runId)) return false;
    await this.guard(true);
    const full: ExternalRunResult = { ...result, receivedAt: new Date(this.now()).toISOString() };
    const tmp = join(this.dir, `.${randomBytes(8).toString("hex")}.tmp`);
    try {
      const fh = await open(tmp, "w", 0o600);
      try {
        await fh.writeFile(JSON.stringify(full), "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (!(await this.close(runId))) {
        await rm(tmp, { force: true });
        return false;
      }
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    try {
      await this.renameFile(tmp, this.p(runId, ".result.json"));
    } catch (err) {
      // Nothing else creates <runId>.json, so reopening the run is safe.
      await rm(tmp, { force: true });
      await this.renameFile(this.p(runId, ".closed"), this.p(runId, ".json")).catch(() => {});
      throw err;
    }
    await rm(this.p(runId, ".closed"), { force: true });
    return true;
  }

  /** Close the run without a result (timeout, stop). False when a callback closed it first. */
  async cancel(runId: string): Promise<boolean> {
    if (!EXTERNAL_RUN_ID.test(runId)) return false;
    await this.guard(true);
    const closed = await this.close(runId);
    if (!closed) return false;
    await rm(this.p(runId, ".closed"), { force: true });
    return true;
  }

  async result(runId: string): Promise<ExternalRunResult | null> {
    if (!EXTERNAL_RUN_ID.test(runId)) return null;
    await this.guard();
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
    await this.guard();
    await rm(this.p(runId, ".result.json"), { force: true });
  }

  /**
   * Delete open records and results older than expiresAt + 24 h (a result is dated by its
   * `receivedAt`), stray `.closed` files closed more than 1 h ago and leftover temp files
   * older than 1 h. Returns the count.
   */
  async prune(): Promise<number> {
    await this.guard();
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
      const file = join(this.dir, name);
      if (/^\.[0-9a-f]{16}\.tmp$/.test(name)) {
        try {
          if (now - (await stat(file)).mtimeMs > STRAY_TMP_MS) await drop(name);
        } catch {
          /* gone */
        }
        continue;
      }
      const m = /^(xr-[0-9a-f]{32})(\.json|\.closed|\.result\.json)$/.exec(name);
      if (!m) continue;
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
