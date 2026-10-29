import { describe, expect, it } from "vitest";
import { blockedAddressReason, checkWebhookTarget } from "./net-guard.js";

describe("net guard", () => {
  it("classifies IPv6 transition ranges", () => {
    expect(blockedAddressReason("::7f00:1")).toBe("reserved");
    expect(blockedAddressReason("::ffff:0:a00:5")).toBe("reserved");
    expect(blockedAddressReason("fec0::1")).toBe("reserved");
    expect(blockedAddressReason("100::1")).toBe("reserved");
    expect(blockedAddressReason("64:ff9b:1::1")).toBe("reserved");
    expect(blockedAddressReason("64:ff9b::7f00:1")).toBe("loopback");
    expect(blockedAddressReason("2002:7f00:1::")).toBe("loopback");
    expect(blockedAddressReason("2002:5db8:d822::1")).toBeNull();
    expect(blockedAddressReason("::ffff:8.8.8.8")).toBeNull();
  });

  it("fails closed when the DNS lookup does not answer in time", async () => {
    const never = () => new Promise<string[]>(() => {});
    const res = await checkWebhookTarget("http://slow.test/x", {
      resolve: never,
      lookupTimeoutMs: 5,
    });
    expect(res).toEqual({ ok: false, reason: "slow.test does not resolve (timeout)" });
  });
});
