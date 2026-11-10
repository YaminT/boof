import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { instanceProof, randomInstanceId } from "./instance-proof.js";

describe("instanceProof", () => {
  it("matches node createHmac and rejects a nonce or id of the wrong shape", async () => {
    const id = randomInstanceId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const nonce = "ab".repeat(32);
    const expected = createHmac("sha256", id).update(nonce).digest("hex");
    expect(await instanceProof(id, nonce)).toBe(expected);
    const shortNonce = "ab".repeat(16);
    expect(await instanceProof(id, shortNonce)).toBe(
      createHmac("sha256", id).update(shortNonce).digest("hex"),
    );
    expect(await instanceProof(id, "short")).toBeUndefined();
    expect(await instanceProof(id, "GG".repeat(32))).toBeUndefined();
    expect(await instanceProof("zz", nonce)).toBeUndefined();
    expect(await instanceProof("ab".repeat(32), nonce)).not.toBe(expected);
  });

  it("two ids do not produce the same proof for one nonce", async () => {
    const nonce = "cd".repeat(32);
    const a = await instanceProof(randomInstanceId(), nonce);
    const b = await instanceProof(randomInstanceId(), nonce);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
