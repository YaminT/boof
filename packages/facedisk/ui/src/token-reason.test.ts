import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";
import { connectEventStream } from "./sse.js";
import {
  clearSignInStorageError,
  clearToken,
  getSignInStorageError,
  notifyUnauthorized,
  onSignInStorageError,
  onUnauthorized,
  setToken,
  unauthorizedReason,
} from "./token.js";

const body = (reason?: string) => ({
  error: { code: "unauthenticated", message: "x", details: reason ? { reason } : undefined },
});

const STORAGE_MESSAGE =
  "Browser sessions folder /home/u/.boof/sessions is open to other users. Run chmod go-w /home/u/.boof/sessions.";
const storageBody = {
  error: { code: "browser_sessions_unavailable", message: STORAGE_MESSAGE, details: {} },
};

beforeEach(() => {
  setToken("x"); // storing a key closes the gate, so each test starts with it closed
  clearToken();
  clearSignInStorageError();
});

afterEach(() => {
  clearToken();
  clearSignInStorageError();
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

describe("the sign-in storage error", () => {
  it("a 503 browser_sessions_unavailable surfaces the server message once", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(storageBody), { status: 503 }));
    vi.stubGlobal("fetch", f);
    const changed = vi.fn();
    const off = onSignInStorageError(changed);
    const first = await api.listTasks("a").catch((e: Error) => e);
    const second = await api.listTasks("a").catch((e: Error) => e);
    off();
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toBe(STORAGE_MESSAGE);
    expect((second as Error).message).toBe(STORAGE_MESSAGE);
    expect(f).toHaveBeenCalledTimes(2);
    expect(getSignInStorageError()).toBe(STORAGE_MESSAGE);
    // Two refusals with the same message: the banner is set once, not on every retry.
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("another 503 leaves the storage error unset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "busy" } }), { status: 503 })),
    );
    await Promise.allSettled([api.listTasks("a")]);
    expect(getSignInStorageError()).toBeNull();
  });

  it("the event stream pauses on it: no reconnect while the error persists", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(storageBody), { status: 503 }));
    const sleep = vi.fn(async () => {});
    const stop = connectEventStream({
      url: "api/v1/events",
      headers: () => ({}),
      onMessage: () => {},
      fetchImpl: f as unknown as typeof fetch,
      sleep,
    });
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(getSignInStorageError()).toBe(STORAGE_MESSAGE);
  });
});
