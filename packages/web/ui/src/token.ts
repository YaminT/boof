// API key handling for the browser UI. The key lives in sessionStorage only
// (per tab, never localStorage) and is sent as an Authorization header, never in a URL.
// The desktop app injects its own key through the preload bridge.

import { createAuthHold } from "./lib/auth-hold.js";

const KEY = "boofToken";
const authHold = createAuthHold();

/**
 * Ignore 401s for a few seconds while this browser's own key is being rotated. The old stream may
 * still report the old key as rejected after the new one is stored, so the hold simply runs out.
 */
export const holdUnauthorized = (ms?: number): void => authHold.hold(ms);
export const releaseUnauthorized = (): void => authHold.release();

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

export function notifyUnauthorized(): void {
  if (authHold.held()) return;
  for (const fn of [...listeners]) fn();
}
