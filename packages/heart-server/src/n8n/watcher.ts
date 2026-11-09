import { mkdir, readFile } from "node:fs/promises";
import { dataRootPaths, lockedAtomicWrite, SettingsStore } from "@boof/heart";
import type { TaskService } from "../api/services/service.js";
import type { N8nClient } from "./client.js";
import { cleanN8nName } from "./text.js";
import type { N8nWorkflowSummary } from "./workflows.js";

export interface N8nWatcherOptions {
  root: string;
  service: TaskService;
  client: N8nClient;
  now?: () => number;
}

export interface N8nTickResult {
  created: string[];
  updated: string[];
}

const DEFAULT_POLL_MS = 300_000;
/** Most check tasks created or updated by one pass; the rest wait for the next pass. */
export const MAX_CHECK_TASKS_PER_PASS = 10;
/** Most per rolling hour; at the cap the watcher warns once and defers the rest. */
export const MAX_CHECK_TASKS_PER_HOUR = 50;
const HOUR_MS = 3_600_000;
/** `stop()` waits at most this long for a running pass (which it aborts). */
export const STOP_WAIT_MS = 5_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

interface SeenState {
  origin: string;
  seen: Record<string, string>;
}

/** `seen.json` is `{ origin, seen }`. Another origin, or the old flat form, reads as no state. */
async function readSeen(root: string, origin: string): Promise<Record<string, string> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(dataRootPaths(root).n8nSeen, "utf8"));
    if (!isRecord(parsed) || parsed.origin !== origin || !isRecord(parsed.seen)) return null;
    return Object.fromEntries(
      Object.entries(parsed.seen).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return null;
  }
}

async function writeSeen(root: string, state: SeenState): Promise<void> {
  const paths = dataRootPaths(root);
  await mkdir(paths.n8n, { recursive: true, mode: 0o700 });
  await lockedAtomicWrite(paths.n8nSeen, JSON.stringify(state, null, 2) + "\n");
}

/** `updatedAt` as ISO UTC (`…Z`), or null when n8n sent something that is not a date. */
function normaliseUpdatedAt(raw: string): string | null {
  if (raw.trim() === "") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Opt-in (`settings.n8n.checks.enabled`): polls the n8n workflow list and, when a workflow's
 * `updatedAt` changes, creates a check task in `checks.projectId` (a draft unless `autoQueue`).
 * It never runs anything itself, and a workflow seen for the first time is only recorded.
 *
 * - `seen.json` holds the current workflows only, so a workflow that disappears from the list
 *   (deleted, archived) and comes back is treated as new: recorded without a task. An edit made
 *   while it was missing gets no check. This keeps the file bounded.
 * - `seen.json` is tied to the n8n origin; after a `baseUrl` change the first pass only records.
 * - Names from n8n are cleaned ({@link cleanN8nName}) and `updatedAt` is normalised to ISO UTC
 *   before use; a value that cannot be used is skipped with one warning per workflow and
 *   `updatedAt`, and recorded so it is not retried.
 * - At most {@link MAX_CHECK_TASKS_PER_PASS} tasks per pass and {@link MAX_CHECK_TASKS_PER_HOUR}
 *   per hour; deferred workflows keep their old value and are picked up on later passes.
 */
export class N8nWatcher {
  private running: Promise<N8nTickResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private generation = 0;
  private abort: AbortController | null = null;
  private recent: number[] = [];
  private hourWarned = false;
  private readonly now: () => number;

  constructor(private readonly opts: N8nWatcherOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** One pass; not re-entrant (an overlapping call returns { created: [], updated: [] }). */
  tick(): Promise<N8nTickResult> {
    if (this.running) return Promise.resolve({ created: [], updated: [] });
    const controller = new AbortController();
    this.abort = controller;
    const pass = this.pass(controller.signal).finally(() => {
      this.running = null;
      if (this.abort === controller) this.abort = null;
    });
    this.running = pass;
    return pass;
  }

  /** Interval = `checks.pollIntervalMs`, re-read every pass. The first pass runs at once. Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation++;
    this.schedule(0, this.generation);
  }

  /** Aborts a running pass and waits for it, at most {@link STOP_WAIT_MS}. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    const running = this.running;
    if (!running) return;
    let waitTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      running.catch(() => undefined),
      new Promise<void>((r) => {
        waitTimer = setTimeout(r, STOP_WAIT_MS);
      }),
    ]);
    clearTimeout(waitTimer);
  }

  private schedule(delayMs: number, gen: number): void {
    if (this.stopped || gen !== this.generation) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const startedAt = this.now();
      void this.tick()
        .catch((err: unknown) => {
          console.warn(`n8n watcher: pass failed (${errorName(err)})`);
        })
        .then(async () => {
          const interval = await this.interval();
          this.schedule(Math.max(0, interval - (this.now() - startedAt)), gen);
        });
    }, delayMs);
    this.timer.unref();
  }

  private async interval(): Promise<number> {
    try {
      const n8n = (await new SettingsStore(this.opts.root).load()).n8n;
      return n8n?.checks?.pollIntervalMs ?? DEFAULT_POLL_MS;
    } catch {
      return DEFAULT_POLL_MS;
    }
  }

  private async pass(signal: AbortSignal): Promise<N8nTickResult> {
    const result: N8nTickResult = { created: [], updated: [] };
    const n8n = (await new SettingsStore(this.opts.root).load()).n8n;
    const checks = n8n?.checks;
    if (!n8n || !checks?.enabled) return result;
    const origin = new URL(n8n.baseUrl).origin;

    let workflows: N8nWorkflowSummary[];
    try {
      workflows = (await this.opts.client.refresh(signal)).workflows;
    } catch (err) {
      // Nothing is recorded, so the next pass sees the same edits again.
      if (!signal.aborted) console.warn(`n8n watcher: refresh failed (${errorName(err)})`);
      return result;
    }

    // No state, or state of another n8n instance: this pass only records.
    const previous = await readSeen(this.opts.root, origin);
    const seen: Record<string, string> = {};
    let projectWarned = false;
    let deferred = 0;
    let handled = 0;
    const defer = (id: string, before: string): void => {
      seen[id] = before;
      deferred++;
    };
    for (const wf of workflows) {
      const updatedAt = normaliseUpdatedAt(wf.updatedAt);
      const current = updatedAt ?? wf.updatedAt;
      const before = previous?.[wf.id];
      if (before === undefined || before === current) {
        seen[wf.id] = current;
        continue;
      }
      if (signal.aborted) {
        seen[wf.id] = before;
        continue;
      }
      const label = `${wf.id} ("${cleanN8nName(wf.name, wf.id)}")`;
      if (updatedAt === null) {
        console.warn(`n8n watcher: workflow ${label} has an unusable updatedAt; no check task`);
        seen[wf.id] = current;
        continue;
      }
      const hook = wf.webhooks.find((w) => w.usable);
      if (!hook) {
        console.warn(
          `n8n watcher: workflow ${label} changed but has no usable POST webhook; no check task`,
        );
        seen[wf.id] = current;
        continue;
      }
      if (handled >= MAX_CHECK_TASKS_PER_PASS) {
        defer(wf.id, before);
        continue;
      }
      const now = this.now();
      this.recent = this.recent.filter((t) => now - t < HOUR_MS);
      if (this.recent.length >= MAX_CHECK_TASKS_PER_HOUR) {
        if (!this.hourWarned) {
          this.hourWarned = true;
          console.warn(
            `n8n watcher: ${MAX_CHECK_TASKS_PER_HOUR} check tasks created in the last hour; further edits wait`,
          );
        }
        defer(wf.id, before);
        continue;
      }
      if (this.recent.length === 0) this.hourWarned = false;
      handled++;
      this.recent.push(now);
      try {
        const made = await this.opts.service.createN8nCheckTask(
          checks.projectId,
          {
            workflowId: wf.id,
            workflowName: cleanN8nName(wf.name, wf.id),
            webhookPath: hook.path,
            updatedAt,
          },
          { queue: checks.autoQueue },
        );
        (made.created ? result.created : result.updated).push(made.id);
        seen[wf.id] = current;
      } catch (err) {
        if (errorName(err) === "ZodError") {
          // The data itself is invalid: record it, or every pass would fail the same way.
          console.warn(
            `n8n watcher: workflow ${label} could not be turned into a task (invalid data)`,
          );
          seen[wf.id] = current;
        } else {
          // Keep the old value: the edit is retried on the next pass.
          seen[wf.id] = before;
          if (!projectWarned) {
            projectWarned = true;
            console.warn(
              `n8n watcher: could not create a check task in project ${checks.projectId} (${errorName(err)})`,
            );
          }
        }
      }
    }
    if (deferred > 0) console.warn(`n8n watcher: ${deferred} more edits deferred to later passes`);
    await writeSeen(this.opts.root, { origin, seen });
    return result;
  }
}

function errorName(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return err instanceof Error ? err.name : "error";
}
