import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectEventStream, defaultBackoff } from "./sse.js";

describe("reconnect backoff", () => {
  it("doubles from 1 s to 30 s with jitter of at most 25 %", () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => defaultBackoff(n, mid))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    expect(defaultBackoff(2, () => 0)).toBe(3000);
    expect(defaultBackoff(2, () => 1)).toBe(5000);
    expect(defaultBackoff(9, () => 1)).toBe(37500);
  });
});

describe("stream watchdog", () => {
  beforeEach(() =>
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    }),
  );
  afterEach(() => vi.useRealTimers());

  it("reconnects when no byte arrives for the idle time, and keep-alives keep it open", async () => {
    const enc = new TextEncoder();
    const ctrls: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          ctrls.push(c);
          c.enqueue(enc.encode("event: ready\ndata: {}\n\n"));
          init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
        },
      });
      return new Response(body, { status: 200 });
    });
    const opens = vi.fn();
    const closes = vi.fn();
    const stop = connectEventStream({
      url: "api/v1/events",
      headers: () => ({}),
      onMessage: () => {},
      onOpen: opens,
      onClose: closes,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      idleTimeoutMs: 45_000,
      backoffMs: () => 1000,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(opens).toHaveBeenCalledTimes(1);
    // a comment every 15 s keeps the stream alive
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      ctrls[0].enqueue(enc.encode(": keepalive\n\n"));
    }
    expect(closes).not.toHaveBeenCalled();
    // silence: dropped after the idle time, then reconnected after the backoff
    await vi.advanceTimersByTimeAsync(55_000);
    expect(closes).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(opens).toHaveBeenCalledTimes(2);
    stop();
  });
});
