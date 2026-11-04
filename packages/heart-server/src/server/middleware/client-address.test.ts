import { describe, expect, it } from "vitest";
import { clientAddress, isTrustedProxy, lastForwardedFor } from "./client-address.js";

describe("client address behind a proxy", () => {
  it("takes the last X-Forwarded-For entry, the one our proxy appended", () => {
    expect(lastForwardedFor("203.0.113.7, 198.51.100.1", undefined)).toBe("198.51.100.1");
    expect(lastForwardedFor(" 198.51.100.1 ", undefined)).toBe("198.51.100.1");
    expect(lastForwardedFor("", undefined)).toBeUndefined();
    expect(lastForwardedFor(undefined, undefined)).toBeUndefined();
  });

  it("falls back to the last Forwarded for= pair, unquoted and without port", () => {
    expect(lastForwardedFor(undefined, "for=192.0.2.60;proto=http, for=198.51.100.17")).toBe(
      "198.51.100.17",
    );
    expect(lastForwardedFor(undefined, 'for="[2001:db8::1]:4711";proto=https')).toBe("2001:db8::1");
    expect(lastForwardedFor(undefined, "for=192.0.2.60:8080")).toBe("192.0.2.60");
    expect(lastForwardedFor(undefined, "proto=https")).toBeUndefined();
    // X-Forwarded-For wins when both are present.
    expect(lastForwardedFor("10.0.0.1", "for=192.0.2.60")).toBe("10.0.0.1");
  });

  it("accepts only IP literals, stripping ports; anything else is not used", () => {
    expect(lastForwardedFor("198.51.100.1:4711", undefined)).toBe("198.51.100.1");
    expect(lastForwardedFor("[2001:db8::1]:4711", undefined)).toBe("2001:db8::1");
    expect(lastForwardedFor("2001:db8::1", undefined)).toBe("2001:db8::1");
    expect(lastForwardedFor("not-an-ip", undefined)).toBeUndefined();
    expect(lastForwardedFor("x".repeat(5000), undefined)).toBeUndefined();
    const h = (name: string) => (name === "x-forwarded-for" ? "garbage" : undefined);
    expect(clientAddress(h, "127.0.0.1", ["loopback"])).toEqual({
      peer: "127.0.0.1",
      key: "127.0.0.1",
    });
  });

  it("trusts loopback and listed literals only", () => {
    expect(isTrustedProxy("127.0.0.1", ["loopback"])).toBe(true);
    expect(isTrustedProxy("::ffff:127.0.0.1", ["loopback"])).toBe(true);
    expect(isTrustedProxy("::1", ["loopback"])).toBe(true);
    expect(isTrustedProxy("10.0.0.1", ["loopback"])).toBe(false);
    expect(isTrustedProxy("10.0.0.1", ["10.0.0.1"])).toBe(true);
    expect(isTrustedProxy("::ffff:10.0.0.1", ["10.0.0.1"])).toBe(true);
    expect(isTrustedProxy(undefined, ["loopback"])).toBe(false);
    expect(isTrustedProxy("127.0.0.1", [])).toBe(false);
  });

  it("keys the limiter on the forwarded address only behind a trusted proxy", () => {
    const h = (xff?: string) => (name: string) => (name === "x-forwarded-for" ? xff : undefined);
    expect(clientAddress(h("1.2.3.4, 198.51.100.1"), "127.0.0.1", ["loopback"])).toEqual({
      peer: "127.0.0.1",
      forwardedFor: "198.51.100.1",
      key: "198.51.100.1",
    });
    // Loopback peer, proxies not configured: recorded for the audit log, not trusted for the key.
    expect(clientAddress(h("198.51.100.1"), "127.0.0.1", [])).toEqual({
      peer: "127.0.0.1",
      forwardedFor: "198.51.100.1",
      key: "127.0.0.1",
    });
    // A remote peer sending the header itself: ignored entirely.
    expect(clientAddress(h("198.51.100.1"), "10.1.2.3", [])).toEqual({
      peer: "10.1.2.3",
      key: "10.1.2.3",
    });
    expect(clientAddress(h(), undefined, ["loopback"])).toEqual({
      peer: undefined,
      key: "unknown",
    });
  });
});
