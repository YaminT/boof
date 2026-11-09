import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";
import { connectEventStream } from "./sse.js";
import {
  clearToken,
  notifyUnauthorized,
  onUnauthorized,
  setToken,
  unauthorizedReason,
} from "./token.js";

const body = (reason?: string) => ({
  error: { code: "unauthenticated", message: "x", details: reason ? { reason } : undefined },
});

beforeEach(() => {
  setToken("x"); // storing a key closes the gate, so each test starts with it closed
  clearToken();
});

afterEach(() => {
  clearToken();
  vi.unstubAllGlobals();
});

describe("unauthorizedReason", () => {
  it("browser_session_required → signin", () => {
    expect(unauthorizedReason(body("browser_session_required"))).toBe("signin");
  });

  it("plain unauthenticated, missing details, non-JSON or null → key", () => {
    expect(unauthorizedReason(body())).toBe("key");
    expect(unauthorizedReason(body("mcp_key_required"))).toBe("key");
    expect(unauthorizedReason({ error: { code: "unauthenticated" } })).toBe("key");
    expect(unauthorizedReason({ error: "nope" })).toBe("key");
    expect(unauthorizedReason({})).toBe("key");
    expect(unauthorizedReason("<html>")).toBe("key");
    expect(unauthorizedReason(null)).toBe("key");
    expect(unauthorizedReason(undefined)).toBe("key");
  });
});

describe("the gate", () => {
  it("opens once for a burst of 401s from fetch and the SSE reconnect", async () => {
    const unauthorized = () =>
      new Response(JSON.stringify(body("browser_session_required")), { status: 401 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => unauthorized()),
    );
    const seen = vi.fn();
    const off = onUnauthorized(seen);
    await Promise.allSettled([api.listTasks("a"), api.listTasks("b")]);
    let stop = () => {};
    stop = connectEventStream({
      url: "api/v1/events",
      headers: () => ({}),
      onMessage: () => {},
      onUnauthorized: (sent, reason) => notifyUnauthorized(sent, reason),
      waitForCredentials: () => new Promise(() => {}),
      fetchImpl: (async () => unauthorized()) as unknown as typeof fetch,
      sleep: async () => {},
    });
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith("signin");
    // A stored key reopens the gate for its own 401.
    setToken("boof_bad");
    await Promise.allSettled([api.listTasks("a")]);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });

  it("a plain 401 carries the key reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body()), { status: 401 })),
    );
    const seen = vi.fn();
    const off = onUnauthorized(seen);
    await Promise.allSettled([api.listTasks("a")]);
    expect(seen).toHaveBeenCalledWith("key");
    off();
  });

  it("sends the session cookie with API requests", async () => {
    const f = vi.fn(
      async () => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }),
    );
    vi.stubGlobal("fetch", f);
    await api.listTasks("a");
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].credentials).toBe(
      "same-origin",
    );
  });
});
