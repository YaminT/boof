// The whole path a browser takes: useLive -> connectEventStream -> connection state, against a
// fake server (fetch stub). No React renderer: the hooks are replaced by plain functions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({
  useRef: <T>(v: T) => ({ current: v }),
  useEffect: (fn: () => void | (() => void)) => {
    cleanup = fn() ?? undefined;
  },
}));
let cleanup: (() => void) | undefined;

import { getConnection, resetConnection } from "./lib/connection.js";
import { useLive } from "./useLive.js";

type Server = { mode: "up" | "down" | "401" | "500" };
const enc = new TextEncoder();
const ctrls: ReadableStreamDefaultController<Uint8Array>[] = [];

function fakeServer(s: Server): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (s.mode === "down") throw new TypeError("fetch failed");
    if (String(url).includes("healthz")) return new Response("{}", { status: 200 });
    if (s.mode === "500") return new Response("x", { status: 500 });
    if (s.mode === "401")
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrls.push(c);
        c.enqueue(enc.encode("event: ready\ndata: {}\n\n"));
        init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

const settle = () => vi.advanceTimersByTimeAsync(0);
/** Advance fake time in small steps until `done()`, so a slow machine only costs time. */
async function until(done: () => boolean, maxMs = 300_000): Promise<void> {
  for (let t = 0; t < maxMs && !done(); t += 500) await vi.advanceTimersByTimeAsync(500);
}

describe("connection state through the real event stream", () => {
  let server: Server;
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    ctrls.length = 0;
    server = { mode: "up" };
    const f = fakeServer(server);
    vi.stubGlobal("fetch", (u: string, i?: RequestInit) => f(u, i));
    resetConnection();
  });
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("server stops -> reconnecting -> offline; server returns -> live", async () => {
    useLive({});
    await settle();
    expect(getConnection().state).toBe("live");

    // The server dies: the open stream errors and every new request is refused.
    server.mode = "down";
    for (const c of ctrls) c.error(new Error("reset"));
    await settle();
    // /healthz is asked once the stream drops; it fails too, so we are offline right away.
    await until(() => getConnection().state === "offline", 10_000);
    expect(getConnection().state).toBe("offline");
    expect(getConnection().since).not.toBeNull();

    // Still down after many retries: stays offline, never flips back to live.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getConnection().state).toBe("offline");

    // The server comes back: the next reconnect attempt turns it live.
    server.mode = "up";
    await until(() => getConnection().state === "live", 60_000);
    expect(getConnection()).toEqual({ state: "live", since: null });
  });

  it("a server that answers /healthz but drops the stream shows reconnecting, not offline", async () => {
    useLive({});
    await settle();
    // Stream ends cleanly; /healthz still answers; the next open is refused with a 500.
    server.mode = "500";
    for (const c of ctrls) c.close();
    await until(() => getConnection().state === "reconnecting", 10_000);
    expect(getConnection().state).toBe("reconnecting");
  });

  it("a 401 on the stream shows signed-out and stops retrying; a stored key resumes", async () => {
    server.mode = "401";
    const inner = fakeServer(server);
    const spy = vi.fn((u: string, i?: RequestInit) => inner(u, i));
    vi.stubGlobal("fetch", spy);
    useLive({});
    await settle();
    expect(getConnection().state).toBe("signed-out");
    const calls = spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spy.mock.calls.length).toBe(calls); // no retry storm
    expect(getConnection().state).toBe("signed-out");

    server.mode = "up";
    const { setToken } = await import("./token.js");
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {}, removeItem() {} });
    setToken("k");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getConnection().state).not.toBe("signed-out");
  });

  it("a request 401 over a still-open stream, then a new key: the stream restarts and shows live", async () => {
    // The server restarted behind an open stream: a request 401s (key dropped) while the stream
    // itself stays up. Storing a key must end in `live`, not stay on `reconnecting`.
    useLive({});
    await settle();
    expect(getConnection().state).toBe("live");
    const { reportSignedOut } = await import("./lib/connection.js");
    reportSignedOut();
    expect(getConnection().state).toBe("signed-out");

    const { setToken } = await import("./token.js");
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {}, removeItem() {} });
    setToken("k2");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getConnection()).toEqual({ state: "live", since: null });
  });
});
