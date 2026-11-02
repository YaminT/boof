import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicWrite,
  dataRootPaths,
  securitySettings,
  isUsableSecret,
  WebhookSecretStore,
  type AuthStore,
  type BoofEvent,
  type Client,
  type Webhook,
} from "@boof-runner/shared";
import {
  checkWebhookTarget,
  creatorProblem,
  eventMatches,
  type ResolveHost,
  type TaskService,
} from "@boof-runner/api";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  GLOBAL_SCOPE,
  liveCursor,
  readFeed,
  type FeedCursor,
} from "./events.js";
import { pinnedPost, type PinnedPostInit } from "./pinned-post.js";

/** Delay before retry n (1-based) after a failed delivery; a 6th failure dead-letters. */
export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000];
const TIMEOUT_MS = 10_000;

interface Pending {
  /** The address the event was meant for; a retry for another address is dropped (older entries have none). */
  url?: string;
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
  /** Test seam replacing the delivery: gets the checked addresses the connection must use. */
  send?: (req: PinnedPostInit & { url: string; addresses: readonly string[] }) => Promise<{
    status: number;
  }>;
  /** Test seam: deliver with this `fetch` instead. It does NOT pin the connection: never set it outside tests. */
  unpinnedFetchForTests?: typeof fetch;
  now?: () => number;
  /** DNS for the target check before each delivery; tests inject a fake. */
  resolveHost?: ResolveHost;
  /** How often to look for new events and due retries. */
  intervalMs?: number;
  /**
   * With it, a webhook an API client created is delivered only while that client is live (not
   * revoked or expired) and still covers the webhook's projects; without it nothing is checked.
   */
  authStore?: AuthStore;
}

/**
 * False when an API client created `hook` and is now revoked or expired, or no longer covers the
 * hook's projects: the hook would outlive the key that made it. Webhooks of the local principal,
 * older ones and every hook when no client list is given are live.
 */
export function creatorLive(
  hook: Webhook,
  clients: readonly Client[] | undefined,
  nowMs: number,
): boolean {
  return creatorProblem(hook, clients, nowMs) === null;
}

/** Sign `body` with the webhook secret: `sha256=<hex hmac>`. */
export function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Does `hook` want `event`? Event type patterns and the project filter (global events need `*`). */
export function wants(hook: Webhook, event: BoofEvent): boolean {
  return hook.enabled && subscribed(hook, event);
}

/** Does the subscription (events and projects) cover `event`, whether or not the hook is enabled? */
function subscribed(hook: Webhook, event: BoofEvent): boolean {
  if (!hook.events.some((p) => eventMatches(p, event.type))) return false;
  if (hook.projects === "*") return true;
  return "project" in event && event.project !== undefined && hook.projects.includes(event.project);
}

/**
 * Delivers events to `settings.webhooks`. Runs in the web server process only: each tick reads
 * the events each webhook has not seen (cursor kept in `<data>/webhooks/state.json`), POSTs them
 * signed, retries failures on a schedule and dead-letters what still fails to
 * `<data>/webhooks/dead/<delivery id>.json`.
 */
export class WebhookDispatcher {
  private readonly dir: string;
  private readonly send: NonNullable<DispatcherOptions["send"]>;
  private readonly now: () => number;
  private readonly secrets: WebhookSecretStore;
  private state: State | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly opts: DispatcherOptions) {
    this.dir = dataRootPaths(opts.root).webhooks;
    const doFetch = opts.unpinnedFetchForTests;
    this.send =
      opts.send ??
      (doFetch
        ? async ({ url, headers, body, signal }) => {
            const res = await doFetch(url, {
              method: "POST",
              redirect: "manual",
              signal,
              headers,
              body,
            });
            await res.body?.cancel().catch(() => {});
            return { status: res.status };
          }
        : ({ url, addresses, ...init }) => pinnedPost(url, addresses, init));
    this.now = opts.now ?? Date.now;
    this.secrets = new WebhookSecretStore(opts.root);
  }

  start(): void {
    if (this.timer) return;
    void this.secrets.tighten().catch((e) => console.error("webhooks", e));
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
      const settings = await this.opts.service.loadSettings();
      const hooks = settings.webhooks ?? [];
      const allowed = securitySettings(settings).allowedPrivateWebhookHosts;
      const state = await this.load();
      let dirty = false;
      for (const id of Object.keys(state)) {
        if (!hooks.some((h) => h.id === id)) {
          delete state[id];
          dirty = true;
        }
      }
      const scopes = await this.scopesFor();
      const secrets = await this.secrets.all();
      const clients = this.opts.authStore ? await this.opts.authStore.list() : undefined;
      const results = await Promise.all(
        hooks
          .map((hook) =>
            creatorLive(hook, clients, this.now()) ? hook : { ...hook, enabled: false },
          )
          .map((h) =>
            this.pass(
              h,
              state,
              scopes,
              allowed,
              Object.hasOwn(secrets, h.id) ? secrets[h.id] : undefined,
            ),
          ),
      );
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
  private async pass(
    hook: Webhook,
    state: State,
    scopes: string[],
    allowed: readonly string[],
    secret: string | undefined,
  ): Promise<boolean> {
    let changed = false;
    let hs = Object.hasOwn(state, hook.id) ? state[hook.id] : undefined;
    if (!hs) {
      // A new webhook hears only what happens from now on.
      hs = state[hook.id] = {
        cursor: encodeFeedCursor(await liveCursor(this.opts.root, scopes)),
        pending: [],
      };
      changed = true;
    }
    if (!hook.enabled) {
      // Disabled means stopped: its events are skipped and its queued retries dropped, so
      // enabling it again starts fresh instead of replaying what happened meanwhile.
      const live = encodeFeedCursor(await liveCursor(this.opts.root, scopes));
      if (hs.cursor !== live || hs.pending.length > 0) {
        hs.cursor = live;
        hs.pending = [];
        changed = true;
      }
      return changed;
    }
    // Retries that are due. One captured for another address, or for an event the webhook no
    // longer covers (it was edited since), is dropped.
    const keep: Pending[] = [];
    for (const p of hs.pending) {
      if ((p.url !== undefined && p.url !== hook.url) || !subscribed(hook, p.event)) {
        changed = true;
        continue;
      }
      if (p.nextAt > this.now()) {
        keep.push(p);
        continue;
      }
      changed = true;
      const retry = await this.attempt(hook, p, allowed, secret);
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
            const retry = await this.attempt(
              hook,
              {
                url: hook.url,
                deliveryId: randomUUID(),
                event,
                attempts: 0,
                nextAt: 0,
                lastError: "",
              },
              allowed,
              secret,
            );
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
  private async attempt(
    hook: Webhook,
    p: Pending,
    allowed: readonly string[],
    secret: string | undefined,
  ): Promise<Pending | null> {
    const error = await this.post(hook, p, allowed, secret);
    if (error === null) return null;
    const attempts = p.attempts + 1;
    if (attempts > RETRY_DELAYS_MS.length) {
      await this.deadLetter(hook, { ...p, attempts, lastError: error });
      return null;
    }
    return { ...p, attempts, lastError: error, nextAt: this.now() + RETRY_DELAYS_MS[attempts - 1] };
  }

  /**
   * POST the event. Returns null on a 2xx answer, else a short error text. The target is checked
   * again first: a name can resolve somewhere else than when the webhook was created. The
   * connection is then pinned to the addresses that check approved (`pinnedPost`), so the name
   * is not looked up a second time and a TTL-0 rebind in between cannot redirect the request.
   */
  private async post(
    hook: Webhook,
    p: Pending,
    allowed: readonly string[],
    secret: string | undefined,
  ): Promise<string | null> {
    if (!isUsableSecret(secret)) return `no signing secret for ${hook.id} in webhooks/secrets.json`;
    let target;
    try {
      target = await checkWebhookTarget(hook.url, {
        resolve: this.opts.resolveHost,
        lookupTimeoutMs: TIMEOUT_MS,
        allowedPrivateHosts: allowed,
      });
    } catch (err) {
      return (err as Error).message || "invalid webhook URL";
    }
    if (!target.ok) return `blocked: ${target.reason}`;
    const body = JSON.stringify({ id: p.deliveryId, ...p.event });
    try {
      const res = await this.send({
        url: hook.url,
        addresses: target.addresses,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "boof-runner-webhook",
          "X-Boof-Event": p.event.type,
          "X-Boof-Delivery": p.deliveryId,
          "X-Boof-Signature": sign(secret, body),
        },
        body,
      });
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
