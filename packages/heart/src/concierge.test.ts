import { describe, expect, it } from "vitest";
import { ConciergeTurnError } from "./concierge.js";

describe("ConciergeTurnError", () => {
  it("keeps kind, usage and sessionId", () => {
    const usage = { inputTokens: 3, outputTokens: 4, costUsd: 0.2, known: true };
    const err = new ConciergeTurnError("assistant timed out", "timeout", usage, "sess-1");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("assistant timed out");
    expect(err.kind).toBe("timeout");
    expect(err.usage).toEqual(usage);
    expect(err.sessionId).toBe("sess-1");

    const refused = new ConciergeTurnError("refused", "refused", null, null);
    expect(refused.kind).toBe("refused");
    expect(refused.usage).toBeNull();
    expect(refused.sessionId).toBeNull();
  });
});
