// API key handling for the browser UI. The key lives in sessionStorage only
// (per tab, never localStorage) and is sent as an Authorization header, never in a URL.
// The desktop app injects its own key through the preload bridge.

import { createUnauthorizedGate, type UnauthorizedVerdict } from "./lib/unauthorized-gate.js";

const KEY = "boofToken";
/** Instance id the saved API key was bound to. Absent until an authenticated response names one. */
const INSTANCE_KEY = "boofInstance";
/** A mismatch or a reload of an unbound saved key: do not attach the key again until the user enters one. */
let authBlocked = false;
/** True after `setToken` on this page, so that one request may bind a key the user just typed. */
let keyEnteredThisPage = false;

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
  authBlocked = false;
  keyEnteredThisPage = true;
  try {
    const s = store();
    // The new key is not bound yet. The next successful response binds it to that server.
    s?.removeItem(INSTANCE_KEY);
    s?.setItem(KEY, token.trim());
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
  authBlocked = false;
  keyEnteredThisPage = false;
  try {
    const s = store();
    s?.removeItem(KEY);
    s?.removeItem(INSTANCE_KEY);
  } catch {
    /* ignore */
  }
}

/** The instance id this page's saved key is bound to, if it has been learned. */
export function getBoundInstance(): string | undefined {
  try {
    return store()?.getItem(INSTANCE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

/** Remember the server instance a successful authenticated response named. */
export function bindInstance(id: string): void {
  try {
    store()?.setItem(INSTANCE_KEY, id);
  } catch {
    /* ignore */
  }
}

export function authIsBlocked(): boolean {
  return authBlocked;
}

export function keyWasEnteredThisPage(): boolean {
  return keyEnteredThisPage;
}

/**
 * Forget the saved key and its instance. Further requests on this page omit the key, including a
 * desktop key, until the user enters one or reloads.
 */
export function blockSavedKey(): void {
  authBlocked = true;
  keyEnteredThisPage = false;
  try {
    const s = store();
    s?.removeItem(KEY);
    s?.removeItem(INSTANCE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * A key restored from sessionStorage with no instance binding would be sent to whoever now
 * listens. Drop it. A key typed on this page, and the desktop bridge key, are left in place.
 * Returns true when a saved key was removed.
 */
export function discardUnboundSavedKey(): boolean {
  if (keyEnteredThisPage || authBlocked || getBoundInstance()) return false;
  try {
    const s = store();
    if (!s?.getItem(KEY)) return false;
    s.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

/** Headers carrying the key, or an empty object when none is set or the key was dropped. */
export function authHeaders(): Record<string, string> {
  if (authBlocked) return {};
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

/**
 * The server message for a 503 `browser_sessions_unavailable` (its browser-session folder has
 * unsafe permissions; the message is fixed and the server log names the path), or undefined for any other answer.
 */
export function storageUnavailableMessage(status: number, body: unknown): string | undefined {
  if (status !== 503) return undefined;
  const err = (body as { error?: unknown } | null | undefined)?.error;
  if (typeof err !== "object" || err === null) return undefined;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return code === "browser_sessions_unavailable" && typeof message === "string" && message
    ? message
    : undefined;
}

let storageError: string | null = null;
const storageListeners = new Set<() => void>();

/**
 * Record the sign-in storage error. Only a change notifies, so a repeated 503 with the same
 * message (every retry) does not show it again.
 */
export function reportSignInStorageError(message: string): void {
  if (storageError === message) return;
  storageError = message;
  for (const fn of [...storageListeners]) fn();
}

/** The sign-in storage error to show, or null. */
export function getSignInStorageError(): string | null {
  return storageError;
}

/** Subscribe to a change of the sign-in storage error. Returns an unsubscribe function. */
export function onSignInStorageError(fn: () => void): () => void {
  storageListeners.add(fn);
  return () => storageListeners.delete(fn);
}

/** Forget the recorded storage error (tests). */
export function clearSignInStorageError(): void {
  storageError = null;
}
