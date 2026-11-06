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

const listeners = new Set<() => void>();

/** Subscribe to 401 responses (the app shows the token gate). Returns an unsubscribe function. */
export function onUnauthorized(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const gate = createUnauthorizedGate(
  () => getToken(),
  () => {
    for (const fn of [...listeners]) fn();
  },
);

/**
 * A request or the event stream was refused. `sent` is the key it carried (the current one when
 * left out). A stale key's 401 is ignored, and the verdict tells the caller so it can retry with
 * the current key.
 */
export function notifyUnauthorized(sent?: string): UnauthorizedVerdict {
  return gate.unauthorized(sent);
}

/** This browser's own key is being rotated: its 401s wait for the outcome. */
export const beginKeyRotation = (): void => gate.begin(getToken());
export const keyRotationSucceeded = (): void => gate.succeeded();
export const keyRotationFailed = (): void => gate.failed();
