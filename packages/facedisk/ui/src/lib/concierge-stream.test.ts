import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api.js";
import { setToken } from "../token.js";
import { parseSse } from "./concierge-stream.js";

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

afterEach(() => vi.unstubAllGlobals());

describe("parseSse", () => {
  it("joins a line split across chunks", () => {
    const first = parseSse("", "event: text\ndata: hel");
    expect(first.events).toEqual([]);
    const second = parseSse(first.carry, 'lo"\n\n');
    expect(second.events).toEqual([{ event: "text", data: 'hello"' }]);
    expect(second.carry).toBe("");
  });

  it("returns two events from one chunk", () => {
    const parsed = parseSse("", "event: text\ndata: one\n\nevent: done\ndata: two\n\n");
    expect(parsed.events).toEqual([
      { event: "text", data: "one" },
      { event: "done", data: "two" },
    ]);
    expect(parsed.carry).toBe("");
  });

  it("accepts CRLF and ignores comment lines", () => {
    const parsed = parseSse("", ": keep-alive\r\n\r\nevent: pending\r\ndata: a\r\ndata: b\r\n\r\n");
    expect(parsed.events).toEqual([{ event: "pending", data: "a\nb" }]);
    expect(parsed.carry).toBe("");
  });
});

describe("api.conciergeStream", () => {
  it("delivers events in order and keeps the key out of the URL", async () => {
    vi.stubGlobal("sessionStorage", new MemoryStorage());
    setToken("boof_a_secret");
    const payload = [
      { type: "conversation", conversationId: "c1" },
      { type: "text", text: "Hello" },
      { type: "tool", tool: "tasks.delete", phase: "start" },
      { type: "done", answer: { conversationId: "c1", text: "Hello" } },
    ];
    const wire = payload
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    const mid = Math.floor(wire.length / 2);
    const chunks = [wire.slice(0, mid), wire.slice(mid)];
    let i = 0;
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (i < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[i++]));
              else controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const events: unknown[] = [];
    const signal = new AbortController().signal;
    await api.conciergeStream(
      "demo",
      { text: "hi", context: { screen: "tasks" } },
      (event) => {
        events.push(event);
      },
      signal,
    );
    expect(events).toEqual(payload);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("api/v1/projects/demo/concierge/messages/stream");
    expect(seen[0]!.url).not.toContain("boof_");
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.signal).toBe(signal);
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.accept).toBe("text/event-stream");
    expect(headers.authorization).toBe("Bearer boof_a_secret");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      text: "hi",
      context: { screen: "tasks" },
    });
  });

  it("rejects a 409 JSON answer with the server message and no events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "budget_exceeded", message: "budget used up" } }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const events: unknown[] = [];
    const err = await api
      .conciergeStream("demo", { text: "hi" }, (event) => events.push(event))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(events).toEqual([]);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("budget used up");
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("budget_exceeded");
  });
});
