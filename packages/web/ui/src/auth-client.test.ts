import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";
import { connectEventStream, readSse, SseParser, type SseMessage } from "./sse.js";
import { clearToken, getToken, onUnauthorized, setToken } from "./token.js";

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const enc = new TextEncoder();
function streamOf(chunks: string[], { hang = false } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else if (!hang) controller.close();
    },
  });
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", new MemoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("token store", () => {
  it("keeps the key in sessionStorage only", () => {
    expect(getToken()).toBeUndefined();
    setToken("  boof_a_b  ");
    expect(getToken()).toBe("boof_a_b");
    clearToken();
    expect(getToken()).toBeUndefined();
  });

  it("prefers the desktop bridge token", () => {
    vi.stubGlobal("boofRunnerDesktop", { token: "boof_desktop_x" });
    setToken("boof_other_y");
    expect(getToken()).toBe("boof_desktop_x");
  });
});

describe("api fetch wrapper", () => {
  it("adds Authorization: Bearer when a key is set and omits it otherwise", async () => {
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init.headers as Record<string, string>);
        return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      }),
    );
    await api.listTasks("demo");
    expect(seen[0].authorization).toBeUndefined();
    setToken("boof_a_secret");
    await api.listTasks("demo");
    expect(seen[1].authorization).toBe("Bearer boof_a_secret");
    expect(seen[1]["content-type"]).toBe("application/json");
  });

  it("signals the token gate on 401 and surfaces the server message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "unauthenticated", message: "nope" } }), {
            status: 401,
          }),
      ),
    );
    const seen = vi.fn();
    const off = onUnauthorized(seen);
    await expect(api.listTasks("demo")).rejects.toThrow("nope");
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("SSE parsing", () => {
  it("parses event/data lines, comments, multi-line data and split chunks", () => {
    const p = new SseParser();
    const out: SseMessage[] = [];
    for (const chunk of [
      "event: ready\ndata: conn",
      "ected\n\n: keep-alive\n\nevent: changed\r\n",
      "data: a\r\ndata: b\r\n\r\ndata: bare\n\n",
    ]) {
      out.push(...p.push(chunk));
    }
    expect(out).toEqual([
      { event: "ready", data: "connected" },
      { event: "changed", data: "a\nb" },
      { event: "message", data: "bare" },
    ]);
  });

  it("readSse decodes a ReadableStream of bytes", async () => {
    const got: SseMessage[] = [];
    await readSse(streamOf(["event: chan", "ged\ndata: 1\n\n"]), (m) => got.push(m));
    expect(got).toEqual([{ event: "changed", data: "1" }]);
  });
});

describe("connectEventStream", () => {
  it("sends the key in a header, delivers events, and reconnects with backoff", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const delays: number[] = [];
    const messages: string[] = [];
    let opens = 0;
    let stop: () => void = () => {};

    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      const n = calls.length;
      if (n === 1) return new Response(streamOf(["event: changed\ndata: 1\n\n"]), { status: 200 });
      if (n === 2) throw new Error("network down");
      if (n === 3) return new Response("boom", { status: 503 });
      // 4th connection stays open, then we stop.
      queueMicrotask(() => setTimeout(() => stop(), 10));
      return new Response(streamOf(["event: changed\ndata: 2\n\n"], { hang: true }), {
        status: 200,
      });
    });

    const done = new Promise<void>((resolve) => {
      stop = connectEventStream({
        url: "/api/events",
        headers: () => ({ authorization: "Bearer boof_a_secret" }),
        onMessage: (m) => messages.push(`${m.event}:${m.data}`),
        onOpen: () => (opens += 1),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        backoffMs: (attempt) => 100 * (attempt + 1),
        sleep: async (ms) => {
          delays.push(ms);
        },
      });
      setTimeout(resolve, 200);
    });
    await done;

    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls.every((c) => c.url === "/api/events")).toBe(true);
    expect(calls.every((c) => c.headers.authorization === "Bearer boof_a_secret")).toBe(true);
    expect(calls[0].url).not.toContain("boof_");
    expect(messages.slice(0, 2)).toEqual(["changed:1", "changed:2"]);
    expect(opens).toBe(2);
    // After the clean end of stream 1: attempt 0; failures at 2 and 3 grow the delay.
    expect(delays.slice(0, 3)).toEqual([100, 200, 300]);
  });

  it("stops and reports on 401 instead of reconnecting forever", async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    connectEventStream({
      url: "/api/events",
      headers: () => ({}),
      onMessage: () => {},
      onUnauthorized,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
