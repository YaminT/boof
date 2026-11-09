import { mkdir, readFile } from "node:fs/promises";
import { dataRootPaths, lockedAtomicWrite, SettingsStore } from "@boof/heart";
import type { TaskService } from "../api/services/service.js";
import type { N8nClient } from "./client.js";
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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

async function readSeen(root: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(dataRootPaths(root).n8nSeen, "utf8"));
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {};
  }
}

async function writeSeen(root: string, seen: Record<string, string>): Promise<void> {
  const paths = dataRootPaths(root);
  await mkdir(paths.n8n, { recursive: true, mode: 0o700 });
  await lockedAtomicWrite(paths.n8nSeen, JSON.stringify(seen, null, 2) + "\n");
}

/**
 * Opt-in (`settings.n8n.checks.enabled`): polls the n8n workflow list and, when a workflow's
 * `updatedAt` changes, creates a check task in `checks.projectId` (a draft unless `autoQueue`).
 * It never runs anything itself, and a workflow seen for the first time is only recorded.
 */
export class N8nWatcher {
  private running: Promise<N8nTickResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private readonly now: () => number;

  constructor(private readonly opts: N8nWatcherOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** One pass; not re-entrant (an overlapping call returns { created: [], updated: [] }). */
  tick(): Promise<N8nTickResult> {
    if (this.running) return Promise.resolve({ created: [], updated: [] });
    const pass = this.pass().finally(() => {
      this.running = null;
    });
    this.running = pass;
    return pass;
  }

  /** Interval = `checks.pollIntervalMs`, re-read every pass. The first pass runs at once. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const startedAt = this.now();
      void this.tick()
        .catch((err: unknown) => {
          console.warn(`n8n watcher: pass failed (${errorName(err)})`);
        })
        .then(async () => {
          const interval = await this.interval();
          this.schedule(Math.max(0, interval - (this.now() - startedAt)));
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

  private async pass(): Promise<N8nTickResult> {
    const result: N8nTickResult = { created: [], updated: [] };
    const n8n = (await new SettingsStore(this.opts.root).load()).n8n;
    const checks = n8n?.checks;
    if (!n8n || !checks?.enabled) return result;

    let workflows: N8nWorkflowSummary[];
    try {
      workflows = (await this.opts.client.refresh()).workflows;
    } catch (err) {
      // Nothing is recorded, so the next pass sees the same edits again.
      console.warn(`n8n watcher: refresh failed (${errorName(err)})`);
      return result;
    }

    const previous = await readSeen(this.opts.root);
    const seen: Record<string, string> = {};
    let projectWarned = false;
    for (const wf of workflows) {
      const before = previous[wf.id];
      if (before === undefined || before === wf.updatedAt) {
        seen[wf.id] = wf.updatedAt;
        continue;
      }
      const hook = wf.webhooks.find((w) => w.usable);
      if (!hook) {
        console.warn(
          `n8n watcher: workflow ${wf.id} changed but has no usable POST webhook; no check task`,
        );
        seen[wf.id] = wf.updatedAt;
        continue;
      }
      try {
        const made = await this.opts.service.createN8nCheckTask(
          checks.projectId,
          {
            workflowId: wf.id,
            workflowName: wf.name,
            webhookPath: hook.path,
            updatedAt: wf.updatedAt,
          },
          { queue: checks.autoQueue },
        );
        (made.created ? result.created : result.updated).push(made.id);
        seen[wf.id] = wf.updatedAt;
      } catch (err) {
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
    await writeSeen(this.opts.root, seen);
    return result;
  }
}

function errorName(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return err instanceof Error ? err.name : "error";
}
