// API key handling for the browser UI. The key lives in sessionStorage only
// (per tab, never localStorage) and is sent as an Authorization header, never in a URL.
// The desktop app injects its own key through the preload bridge.

import { createUnauthorizedGate, type UnauthorizedVerdict } from "./lib/unauthorized-gate.js";

const KEY = "boofToken";

function store(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function desktopToken(): string | undefined {
  const w = (globalThis as { boofRunnerDesktop?: { token?: string } }).boofRunnerDesktop;
  return w?.token || undefined;
}

export function getToken(): string | undefined {
  try {
    return desktopToken() ?? (store()?.getItem(KEY) || undefined);
  } catch {
    return undefined;
  }
}

export function setToken(token: string): void {
  gateOpen = false; // a new key may be refused again: that 401 reopens the gate
  try {
    store()?.setItem(KEY, token.trim());
  } catch {
    /* sessionStorage unavailable: the key lasts until reload via callers' state */
  }
  for (const fn of [...tokenListeners]) fn();
}

const tokenListeners = new Set<() => void>();

/** Subscribe to a new key being stored (the event stream resumes). Returns an unsubscribe function. */
export function onTokenChange(fn: () => void): () => void {
  tokenListeners.add(fn);
  return () => tokenListeners.delete(fn);
}

export function clearToken(): void {
  try {
    store()?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Headers carrying the key, or an empty object when none is set. */
export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

/** What the gate asks for: a browser sign-in link, or an API key. */
export type UnauthorizedReason = "signin" | "key";

/** "signin" iff the 401 body says this browser has no session (`error.details.reason`). */
export function unauthorizedReason(body: unknown): UnauthorizedReason {
  const err = (body as { error?: unknown } | null | undefined)?.error;
  const details =
    typeof err === "object" && err !== null ? (err as { details?: unknown }).details : undefined;
  const reason =
    typeof details === "object" && details !== null
      ? (details as { reason?: unknown }).reason
      : undefined;
  return reason === "browser_session_required" ? "signin" : "key";
}

const listeners = new Set<(reason: UnauthorizedReason) => void>();
// The gate is open until a key is stored: a burst of 401s (fetches, the event stream's
// reconnects) opens it once, for either reason.
let gateOpen = false;
let lastReason: UnauthorizedReason = "key";

/** Subscribe to 401 responses (the app shows the gate). Returns an unsubscribe function. */
export function onUnauthorized(fn: (reason: UnauthorizedReason) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const gate = createUnauthorizedGate(
  () => getToken(),
  () => {
    if (gateOpen) return;
    gateOpen = true;
    for (const fn of [...listeners]) fn(lastReason);
  },
);

/**
 * A request or the event stream was refused. `sent` is the key it carried (the current one when
 * left out). A stale key's 401 is ignored, and the verdict tells the caller so it can retry with
 * the current key.
 */
export function notifyUnauthorized(
  sent?: string,
  reason: UnauthorizedReason = "key",
): UnauthorizedVerdict {
  lastReason = reason;
  return gate.unauthorized(sent);
}

/** This browser's own key is being rotated: its 401s wait for the outcome. */
export const beginKeyRotation = (): void => gate.begin(getToken());
export const keyRotationSucceeded = (): void => gate.succeeded();
export const keyRotationFailed = (): void => gate.failed();
