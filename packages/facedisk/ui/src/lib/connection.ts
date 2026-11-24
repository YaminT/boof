// One shared answer to "is boof connected?", for the topbar and Home. It is fed by the event
// stream (useLive) and by 401s; it adds no polling of its own. While the stream is down it asks
// `/healthz` at most once a minute to tell "reconnecting" (the server answers) from "offline".

import { onTokenChange, onUnauthorized } from "../token.js";

export type ConnectionState = "live" | "reconnecting" | "offline" | "signed-out";

export interface Connection {
  state: ConnectionState;
  /** When the connection last left `live` (ms since epoch); null while live. */
  since: number | null;
}

/** A cached `/healthz` answer is reused this long. */
export const HEALTH_TTL_MS = 60_000;
/** The stream counts as silent after this long without a byte (the server beats every 15 s). */
export const STREAM_IDLE_MS = 45_000;

let current: Connection = { state: "live", since: null };
const listeners = new Set<() => void>();
let health: { at: number; ok: boolean } | null = null;
let healthInflight: Promise<boolean> | null = null;
let wired = false;
let fetchImpl: typeof fetch | undefined;

function set(state: ConnectionState): void {
  wire();
  if (current.state === state) return;
  const since = state === "live" ? null : (current.since ?? Date.now());
  // Offline is dated from when it began, not from when the stream first dropped.
  current = { state, since: state === "offline" ? Date.now() : since };
  for (const fn of [...listeners]) fn();
}

export function getConnection(): Connection {
  return current;
}

export function subscribeConnection(fn: () => void): () => void {
  listeners.add(fn);
  wire();
  return () => listeners.delete(fn);
}

function wire(): void {
  if (wired) return;
  wired = true;
  onUnauthorized(() => reportSignedOut());
  // A key was stored (sign-in): the stream resumes by itself; show that it is trying again.
  onTokenChange(() => {
    if (current.state === "signed-out") set("reconnecting");
  });
}

/** The stream is up and delivering. */
export function reportStreamUp(): void {
  set("live");
}

/** The stream dropped, was silent too long, or failed to open. */
export function reportStreamDown(): void {
  if (current.state === "signed-out") return;
  set("reconnecting");
  void checkHealth().then((ok) => {
    // Only a still-broken stream may turn offline; a stream that came back stays live.
    if (!ok && current.state === "reconnecting") set("offline");
    else if (ok && current.state === "offline") set("reconnecting");
  });
}

/** A request or the stream got a 401. */
export function reportSignedOut(): void {
  set("signed-out");
}

/** The user signed in again. */
export function reportSignedIn(): void {
  if (current.state === "signed-out") set("reconnecting");
}

/** `/healthz` answered ok? Cached for a minute; one request at a time. */
export function checkHealth(): Promise<boolean> {
  if (health && Date.now() - health.at < HEALTH_TTL_MS) return Promise.resolve(health.ok);
  if (healthInflight) return healthInflight;
  const doFetch = fetchImpl ?? fetch;
  healthInflight = (async () => {
    let ok = false;
    try {
      const res = await doFetch("healthz", {
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    health = { at: Date.now(), ok };
    return ok;
  })().finally(() => {
    healthInflight = null;
  });
  return healthInflight;
}

/** Tests: start over. */
export function resetConnection(opts: { fetchImpl?: typeof fetch } = {}): void {
  current = { state: "live", since: null };
  health = null;
  healthInflight = null;
  fetchImpl = opts.fetchImpl;
  for (const fn of [...listeners]) fn();
}

export function tooltip(c: Connection, fmt: (ms: number) => string = clock): string {
  switch (c.state) {
    case "live":
      return "Connected";
    case "reconnecting":
      return "Reconnecting…";
    case "offline":
      return c.since ? `Offline since ${fmt(c.since)}` : "Offline";
    case "signed-out":
      return "Sign in needed";
  }
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
