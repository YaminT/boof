/**
 * A per-start server id and a proof of it. `/healthz` returns only the proof (HMAC of a nonce),
 * so another local user who reads the public probe cannot later impersonate this process.
 * The web UI learns the id from an authenticated response and checks the proof before sending
 * its API key again.
 */

const INSTANCE_ID = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32,128}$/;

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** 32 random bytes, hex. One value per server process. */
export function randomInstanceId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * HMAC-SHA256(instanceId, nonce), hex. Undefined when either value is not the expected hex.
 * The same bytes as Node's `createHmac("sha256", instanceId).update(nonce)`.
 */
export async function instanceProof(
  instanceId: string,
  nonce: string,
): Promise<string | undefined> {
  if (!INSTANCE_ID.test(instanceId) || !NONCE.test(nonce)) return undefined;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(instanceId),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(nonce));
  return toHex(new Uint8Array(sig));
}
