// Before the UI sends a saved API key, the listener must prove it is the server that key was
// bound to. A port squatter can answer `/healthz` but cannot forge the HMAC.

import { instanceProof } from "@boof/heart/instance-proof";
import {
  authIsBlocked,
  bindInstance,
  blockSavedKey,
  discardUnboundSavedKey,
  getBoundInstance,
  getToken,
} from "./token.js";

/** A proof of the bound instance is reused this long (one `/healthz` per minute per tab). */
const PROOF_TTL_MS = 60_000;
/** Wait before re-probing after the nth consecutive failed probe (the last value repeats). */
const RETRY_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];
let proven: { bound: string; until: number } | null = null;
let failed: { bound: string; count: number; retryAt: number } | null = null;
let inflight: { bound: string; promise: Promise<InstanceCheck> } | null = null;

/** Forget cached proofs and failures (tests, and sign-out). */
export function resetInstanceProof(): void {
  proven = null;
  failed = null;
  inflight = null;
}

const INSTANCE_ID = /^[0-9a-f]{64}$/;

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function sameProof(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Record `X-Boof-Instance` from a response the key was sent to. A different id drops the key.
 * Returns without binding when the header is missing or not an instance id.
 */
export function noteInstanceHeader(value: string | null): void {
  if (!value || !INSTANCE_ID.test(value)) return;
  const bound = getBoundInstance();
  if (bound && bound !== value) {
    resetInstanceProof();
    blockSavedKey();
    return;
  }
  bindInstance(value);
}

export type InstanceCheck = "send" | "omit-key" | "withhold";

/**
 * `send`: the request may carry the key.
 * `omit-key`: make the request without the key (it was for a different server, or never bound).
 * `withhold`: do not connect. The saved key is still bound, and this listener did not prove it
 * (the server is down, or the probe failed closed).
 */
export function confirmInstance(fetchImpl: typeof fetch = fetch): Promise<InstanceCheck> {
  if (authIsBlocked()) return Promise.resolve("omit-key");
  discardUnboundSavedKey();
  const bound = getBoundInstance();
  const token = getToken();
  // Nothing to protect, or a key that was just typed and is not bound yet.
  if (!bound || !token) return Promise.resolve("send");

  const now = Date.now();
  // A proof of this instance is fresh: no probe. A different instance id never reuses it.
  if (proven && proven.bound === bound && now < proven.until) return Promise.resolve("send");
  // The last probe failed closed: do not probe again before the backoff has passed.
  if (failed && failed.bound === bound && now < failed.retryAt) return Promise.resolve("withhold");
  // One probe at a time; concurrent callers share its answer.
  if (inflight && inflight.bound === bound) return inflight.promise;
  const promise = probe(bound, fetchImpl).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { bound, promise };
  return promise;
}

async function probe(bound: string, fetchImpl: typeof fetch): Promise<InstanceCheck> {
  const nonce = randomNonce();
  const fail = (): InstanceCheck => {
    const count = (failed?.bound === bound ? failed.count : 0) + 1;
    const wait = RETRY_BACKOFF_MS[Math.min(count, RETRY_BACKOFF_MS.length) - 1];
    failed = { bound, count, retryAt: Date.now() + wait };
    return "withhold";
  };
  let res: Response;
  try {
    res = await fetchImpl(`healthz?nonce=${encodeURIComponent(nonce)}`, {
      credentials: "omit",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    return fail();
  }
  if (!res.ok) return fail();
  const body = (await res.json().catch(() => null)) as { instanceProof?: unknown } | null;
  const proof = body?.instanceProof;
  const expected = await instanceProof(bound, nonce);
  if (!expected || typeof proof !== "string" || !sameProof(proof, expected)) {
    blockSavedKey();
    proven = null;
    failed = null;
    return "omit-key";
  }
  failed = null;
  proven = { bound, until: Date.now() + PROOF_TTL_MS };
  return "send";
}
