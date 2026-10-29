import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IdempotencyStore } from "./idempotency.js";

describe("IdempotencyStore fingerprints", () => {
  it("fingerprintUpload hashes the bytes themselves, not a JSON copy", () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 0, 255]);
    const expected = createHash("sha256")
      .update("shot.png\0image/png\0")
      .update(bytes)
      .digest("hex");
    expect(IdempotencyStore.fingerprintUpload({ name: "shot.png", type: "image/png", bytes })).toBe(
      expected,
    );
    expect(
      IdempotencyStore.fingerprintUpload({ name: "other.png", type: "image/png", bytes }),
    ).not.toBe(expected);
    expect(
      IdempotencyStore.fingerprintUpload({ name: "shot.png", type: "image/png", bytes }),
    ).not.toBe(IdempotencyStore.fingerprint({ name: "shot.png", type: "image/png", bytes }));
  });
});
