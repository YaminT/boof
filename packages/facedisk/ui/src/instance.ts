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
export async function confirmInstance(fetchImpl: typeof fetch = fetch): Promise<InstanceCheck> {
  if (authIsBlocked()) return "omit-key";
  discardUnboundSavedKey();
  const bound = getBoundInstance();
  const token = getToken();
  // Nothing to protect, or a key that was just typed and is not bound yet.
  if (!bound || !token) return "send";

  const nonce = randomNonce();
  let res: Response;
  try {
    res = await fetchImpl(`healthz?nonce=${encodeURIComponent(nonce)}`, {
      credentials: "omit",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    return "withhold";
  }
  if (!res.ok) return "withhold";
  const body = (await res.json().catch(() => null)) as { instanceProof?: unknown } | null;
  const proof = body?.instanceProof;
  const expected = await instanceProof(bound, nonce);
  if (!expected || typeof proof !== "string" || !sameProof(proof, expected)) {
    blockSavedKey();
    return "omit-key";
  }
  return "send";
}
