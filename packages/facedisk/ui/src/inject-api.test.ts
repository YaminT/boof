import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";

function capture() {
  const bodies: unknown[] = [];
  vi.stubGlobal("window", { location: { origin: "http://x" }, localStorage: undefined });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(init?.body ? JSON.parse(init.body) : undefined);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return bodies;
}

afterEach(() => vi.unstubAllGlobals());

describe("api: inject model and project key", () => {
  it("sends model only with mode now", async () => {
    const bodies = capture();
    await api.injectPrompt("p", "t1", "hi", "now", "opus");
    await api.injectPrompt("p", "t1", "hi", "next-step", "opus");
    await api.injectPrompt("p", "t1", "hi", "now");
    expect(bodies).toEqual([
      { prompt: "hi", mode: "now", model: "opus" },
      { prompt: "hi", mode: "next-step" },
      { prompt: "hi", mode: "now" },
    ]);
  });
});
