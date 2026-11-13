import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instanceProof } from "@boof/heart/instance-proof";
import { api } from "./api.js";
import { resetInstanceProof } from "./instance.js";
import { invalidateCache } from "./lib/request-cache.js";
import { connectEventStream } from "./sse.js";
import { clearToken, getBoundInstance, getToken, setToken } from "./token.js";

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

const INSTANCE = "ab".repeat(32);
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
  clearToken();
  resetInstanceProof();
  invalidateCache();
  vi.stubGlobal("sessionStorage", new MemoryStorage());
});
afterEach(() => {
  clearToken();
  vi.unstubAllGlobals();
});

describe("API key bound to the server instance", () => {
  it("does not send a saved key that was never bound to an instance", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(`${url} ${(init.headers as Record<string, string>).authorization ?? ""}`);
        return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      }),
    );
    sessionStorage.setItem("boofToken", "boof_saved_key");
    await api.listTasks("demo");
    expect(calls).toEqual(["api/v1/projects/demo/tasks?limit=500 "]);
    expect(getToken()).toBeUndefined();
  });

  it("sends a key the user just entered, then binds it to the instance the server names", async () => {
    const calls: Array<{ url: string; authorization?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url: String(url),
          authorization: (init.headers as Record<string, string>).authorization,
        });
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "X-Boof-Instance": INSTANCE },
        });
      }),
    );
    setToken("boof_new_key");
    await api.listTasks("demo");
    expect(calls).toEqual([
      { url: "api/v1/projects/demo/tasks?limit=500", authorization: "Bearer boof_new_key" },
    ]);
    expect(getBoundInstance()).toBe(INSTANCE);
    expect(getToken()).toBe("boof_new_key");
  });

  it("drops the key when the listener's proof does not match the bound instance", async () => {
    const calls: Array<{ url: string; authorization?: string; credentials?: RequestCredentials }> =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        calls.push({
          url: String(url),
          authorization: headers.authorization,
          credentials: init.credentials,
        });
        if (String(url).startsWith("healthz")) {
          return new Response(JSON.stringify({ ok: true, instanceProof: "f".repeat(64) }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      }),
    );
    sessionStorage.setItem("boofToken", "boof_saved_key");
    sessionStorage.setItem("boofInstance", INSTANCE);
    await api.listTasks("demo");
    expect(calls[0].url).toMatch(/^healthz\?nonce=/);
    expect(calls[0].authorization).toBeUndefined();
    expect(calls[0].credentials).toBe("omit");
    expect(calls[1].url).toContain("/tasks");
    expect(calls[1].authorization).toBeUndefined();
    expect(getToken()).toBeUndefined();
    expect(getBoundInstance()).toBeUndefined();
  });

  it("sends the key when the uncredentialed probe proves the same instance", async () => {
    const calls: Array<{ url: string; authorization?: string; credentials?: RequestCredentials }> =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        calls.push({
          url: String(url),
          authorization: headers.authorization,
          credentials: init.credentials,
        });
        if (String(url).startsWith("healthz")) {
          const nonce = new URL(String(url), "http://ui.local").searchParams.get("nonce")!;
          return new Response(
            JSON.stringify({ ok: true, instanceProof: await instanceProof(INSTANCE, nonce) }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "X-Boof-Instance": INSTANCE },
        });
      }),
    );
    sessionStorage.setItem("boofToken", "boof_saved_key");
    sessionStorage.setItem("boofInstance", INSTANCE);
    await api.listTasks("demo");
    expect(calls[0].url).toMatch(/^healthz\?nonce=/);
    expect(calls[0].credentials).toBe("omit");
    expect(calls[0].authorization).toBeUndefined();
    expect(calls[1]).toMatchObject({
      url: "api/v1/projects/demo/tasks?limit=500",
      authorization: "Bearer boof_saved_key",
      credentials: "same-origin",
    });
    expect(getToken()).toBe("boof_saved_key");
  });

  it("does not send the key when the probe cannot reach a server", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        throw new Error("connect ECONNREFUSED");
      }),
    );
    sessionStorage.setItem("boofToken", "boof_saved_key");
    sessionStorage.setItem("boofInstance", INSTANCE);
    await expect(api.listTasks("demo")).rejects.toThrow(/not responding/);
    expect(calls).toEqual([expect.stringMatching(/^healthz\?nonce=/)]);
    expect(getToken()).toBe("boof_saved_key");
    expect(getBoundInstance()).toBe(INSTANCE);
  });
});

describe("event stream reconnect", () => {
  it("does not send the key on reconnect when the instance proof does not match", async () => {
    const id = INSTANCE;
    setToken("boof_saved_key");
    const calls: Array<{ url: string; authorization?: string; credentials?: RequestCredentials }> =
      [];
    let events = 0;
    let sawSecond: () => void = () => {};
    const second = new Promise<void>((resolve) => {
      sawSecond = resolve;
    });
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({
        url: String(url),
        authorization: headers.authorization,
        credentials: init.credentials,
      });
      if (String(url).startsWith("healthz")) {
        return new Response(JSON.stringify({ ok: true, instanceProof: "f".repeat(64) }), {
          status: 200,
        });
      }
      events += 1;
      if (events === 1) {
        return new Response(streamOf(["event: changed\ndata: 1\n\n"]), {
          status: 200,
          headers: { "X-Boof-Instance": id },
        });
      }
      sawSecond();
      return new Response(streamOf(["event: changed\ndata: 2\n\n"], { hang: true }), {
        status: 200,
      });
    });
    const stop = connectEventStream({
      url: "api/v1/events",
      headers: (): Record<string, string> => {
        const token = getToken();
        return token ? { authorization: `Bearer ${token}` } : {};
      },
      onMessage: () => {},
      onUnauthorized: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      backoffMs: () => 0,
    });
    await second;
    stop();
    const eventCalls = calls.filter((c) => c.url === "api/v1/events");
    expect(eventCalls[0].authorization).toBe("Bearer boof_saved_key");
    const probes = calls.filter((c) => c.url.startsWith("healthz"));
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((p) => p.authorization === undefined && p.credentials === "omit")).toBe(
      true,
    );
    expect(eventCalls.slice(1).every((c) => c.authorization === undefined)).toBe(true);
    expect(getToken()).toBeUndefined();
  });
});

describe("instance proof cache", () => {
  const healthzFetch = (calls: string[], ok = true) =>
    vi.fn(async (url: string) => {
      calls.push(String(url));
      if (!String(url).startsWith("healthz")) {
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "X-Boof-Instance": INSTANCE },
        });
      }
      if (!ok) return new Response("down", { status: 503 });
      const nonce = new URL(String(url), "http://ui.local").searchParams.get("nonce")!;
      return new Response(
        JSON.stringify({ ok: true, instanceProof: await instanceProof(INSTANCE, nonce) }),
      );
    });
  const probes = (calls: string[]) => calls.filter((c) => c.startsWith("healthz")).length;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.setItem("boofToken", "boof_saved_key");
    sessionStorage.setItem("boofInstance", INSTANCE);
  });
  afterEach(() => vi.useRealTimers());

  it("probes once for concurrent requests and again only after 60 s", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", healthzFetch(calls));
    await Promise.all([api.whoami(), api.listTasks("a"), api.listTasks("b")]);
    expect(probes(calls)).toBe(1);
    await api.listTasks("c");
    expect(probes(calls)).toBe(1);
    await vi.advanceTimersByTimeAsync(61_000);
    await api.listTasks("d");
    expect(probes(calls)).toBe(2);
  });

  it("withholds without probing again until the backoff (2 s, 5 s, 15 s, 30 s) has passed", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", healthzFetch(calls, false));
    const attempt = () => api.listTasks("a").catch(() => "refused");
    expect(await attempt()).toBe("refused");
    expect(await attempt()).toBe("refused");
    expect(probes(calls)).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await attempt();
    expect(probes(calls)).toBe(2);
    await vi.advanceTimersByTimeAsync(4_000);
    await attempt();
    expect(probes(calls)).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await attempt();
    expect(probes(calls)).toBe(3);
    // 15 s, then 30 s.
    await vi.advanceTimersByTimeAsync(15_000);
    await attempt();
    expect(probes(calls)).toBe(4);
    await vi.advanceTimersByTimeAsync(29_000);
    await attempt();
    expect(probes(calls)).toBe(4);
    await vi.advanceTimersByTimeAsync(1_000);
    await attempt();
    expect(probes(calls)).toBe(5);
  });

  it("drops the key at once when a response names a different instance", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", healthzFetch(calls));
    await api.listTasks("a");
    expect(getToken()).toBe("boof_saved_key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ items: [], nextCursor: null }), {
            status: 200,
            headers: { "X-Boof-Instance": "cd".repeat(32) },
          }),
      ),
    );
    await api.listTasks("b"); // proof still fresh: key sent, header differs
    expect(getToken()).toBeUndefined();
  });
});
