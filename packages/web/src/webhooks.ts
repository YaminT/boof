import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, dataRootPaths, type BoofEvent, type Webhook } from "@boof-runner/shared";
import { eventMatches, type TaskService } from "@boof-runner/api";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  GLOBAL_SCOPE,
  liveCursor,
  readFeed,
  type FeedCursor,
} from "./events.js";

/** Delay before retry n (1-based) after a failed delivery; a 6th failure dead-letters. */
export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000];
const TIMEOUT_MS = 10_000;

interface Pending {
  deliveryId: string;
  event: BoofEvent;
  /** Failed attempts so far. */
  attempts: number;
  nextAt: number;
  lastError: string;
}

interface HookState {
  /** Where in the event history this webhook has been read up to (encoded cursor). */
  cursor: string;
  pending: Pending[];
}

type State = Record<string, HookState>;

export interface DispatcherOptions {
  root: string;
  service: TaskService;
  fetch?: typeof fetch;
  now?: () => number;
  /** How often to look for new events and due retries. */
  intervalMs?: number;
}

/** Sign `body` with the webhook secret: `sha256=<hex hmac>`. */
export function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Does `hook` want `event`? Event type patterns and the project filter (global events need `*`). */
export function wants(hook: Webhook, event: BoofEvent): boolean {
  if (!hook.enabled) return false;
  if (!hook.events.some((p) => eventMatches(p, event.type))) return false;
  if (hook.projects === "*") return true;
  return "project" in event && hook.projects.includes(event.project);
}

/**
 * Delivers events to `settings.webhooks`. Runs in the web server process only: each tick reads
 * the events each webhook has not seen (cursor kept in `<data>/webhooks/state.json`), POSTs them
 * signed, retries failures on a schedule and dead-letters what still fails to
 * `<data>/webhooks/dead/<delivery id>.json`.
 */
export class WebhookDispatcher {
  private readonly dir: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private state: State | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly opts: DispatcherOptions) {
    this.dir = dataRootPaths(opts.root).webhooks;
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.tick().catch((e) => console.error("webhooks", e)),
      this.opts.intervalMs ?? 1000,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private get statePath(): string {
    return join(this.dir, "state.json");
  }

  private async load(): Promise<State> {
    if (this.state) return this.state;
    try {
      this.state = JSON.parse(await readFile(this.statePath, "utf8")) as State;
    } catch {
      this.state = {};
    }
    return this.state;
  }

  private async save(state: State): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await atomicWrite(this.statePath, JSON.stringify(state, null, 2) + "\n");
  }

  /** One pass over all webhooks. Not re-entrant: an overlapping call returns at once. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const hooks = (await this.opts.service.loadSettings()).webhooks ?? [];
      const state = await this.load();
      let dirty = false;
      for (const id of Object.keys(state)) {
        if (!hooks.some((h) => h.id === id)) {
          delete state[id];
          dirty = true;
        }
      }
      const scopes = await this.scopesFor();
      const results = await Promise.all(hooks.map((h) => this.pass(h, state, scopes)));
      if (dirty || results.some(Boolean)) await this.save(state);
    } finally {
      this.running = false;
    }
  }

  private async scopesFor(): Promise<string[]> {
    const projects = await this.opts.service.projects.list({ includeArchived: true });
    return [GLOBAL_SCOPE, ...projects.map((p) => p.id)];
  }

  /** Returns true when the webhook's state changed. */
  private async pass(hook: Webhook, state: State, scopes: string[]): Promise<boolean> {
    let changed = false;
    let hs = state[hook.id];
    if (!hs) {
      // A new webhook hears only what happens from now on.
      hs = state[hook.id] = {
        cursor: encodeFeedCursor(await liveCursor(this.opts.root, scopes)),
        pending: [],
      };
      changed = true;
    }
    // Retries that are due.
    const keep: Pending[] = [];
    for (const p of hs.pending) {
      if (p.nextAt > this.now() || !hook.enabled) {
        keep.push(p);
        continue;
      }
      changed = true;
      const retry = await this.attempt(hook, p);
      if (retry) keep.push(retry);
    }
    hs.pending = keep;
    // New events.
    if (hook.enabled) {
      let cursor: FeedCursor = decodeFeedCursor(hs.cursor) ?? {};
      for (;;) {
        const batch = await readFeed(this.opts.root, scopes, cursor, 100);
        if (batch.length === 0) break;
        for (const { event, cursor: next } of batch) {
          if (wants(hook, event)) {
            const retry = await this.attempt(hook, {
              deliveryId: randomUUID(),
              event,
              attempts: 0,
              nextAt: 0,
              lastError: "",
            });
            if (retry) hs.pending.push(retry);
          }
          hs.cursor = next;
        }
        cursor = decodeFeedCursor(hs.cursor) ?? cursor;
        changed = true;
      }
    }
    return changed;
  }

  /** Deliver once. Returns the entry to retry later, or null when delivered or dead-lettered. */
  private async attempt(hook: Webhook, p: Pending): Promise<Pending | null> {
    const error = await this.post(hook, p);
    if (error === null) return null;
    const attempts = p.attempts + 1;
    if (attempts > RETRY_DELAYS_MS.length) {
      await this.deadLetter(hook, { ...p, attempts, lastError: error });
      return null;
    }
    return { ...p, attempts, lastError: error, nextAt: this.now() + RETRY_DELAYS_MS[attempts - 1] };
  }

  /** POST the event. Returns null on a 2xx answer, else a short error text. */
  private async post(hook: Webhook, p: Pending): Promise<string | null> {
    const body = JSON.stringify({ id: p.deliveryId, ...p.event });
    try {
      const res = await this.doFetch(hook.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "boof-runner-webhook",
          "X-Boof-Event": p.event.type,
          "X-Boof-Delivery": p.deliveryId,
          "X-Boof-Signature": sign(hook.secret, body),
        },
        body,
      });
      await res.body?.cancel().catch(() => {});
      return res.status >= 200 && res.status < 300 ? null : `HTTP ${res.status}`;
    } catch (err) {
      return (err as Error).message || "request failed";
    }
  }

  private async deadLetter(hook: Webhook, p: Pending): Promise<void> {
    const dir = join(this.dir, "dead");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${p.deliveryId}.json`),
      JSON.stringify(
        {
          deliveryId: p.deliveryId,
          webhook: hook.id,
          url: hook.url,
          event: p.event,
          attempts: p.attempts,
          lastError: p.lastError,
          failedAt: new Date(this.now()).toISOString(),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }
}
