import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instanceProof } from "@boof/heart/instance-proof";
import { useCallback } from "react";
import { mount } from "./test-hooks-runtime.js";

vi.mock("react", async () => (await import("./test-hooks-runtime.js")).fakeReact);

const { resetInstanceProof } = await import("./instance.js");
const { invalidateCache } = await import("./lib/request-cache.js");
const { clearToken, setToken } = await import("./token.js");
const { useAppData } = await import("./useAppData.js");
const { useProjects } = await import("./useProjects.js");
const { useRunnerOverview } = await import("./lib/useRunnerOverview.js");
const { useRunningStep } = await import("./lib/useRunningStep.js");
const { useHeldScopes } = await import("./lib/useHeldScopes.js");
const { useHarnesses } = await import("./useHarnesses.js");
const { getUpdateNotice } = await import("./api.js");

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
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "X-Boof-Instance": INSTANCE } });

const BODIES: Record<string, unknown> = {
  "api/v1/runner/status": {
    enabled: true,
    concurrency: 1,
    budgetExceeded: [],
    agentAuth: [],
    projects: [{ id: "demo", paused: false, running: ["t1"], counts: { running: 1 } }],
  },
  "api/v1/whoami": { principal: { name: "k", scopes: ["*"], trust: "trusted", projects: "*" } },
  "api/v1/settings": { runner: { enabled: true, concurrency: 1 }, defaultProject: "demo" },
  "api/v1/actions": { actions: [] },
  "api/v1/projects": { projects: [{ id: "demo", name: "Demo" }] },
  "api/v1/usage/budget": { exceeded: [] },
  "api/v1/harnesses": { harnesses: [] },
  "api/v1/updates": { update: null },
  "api/v1/projects/demo/tasks?limit=500": { items: [], nextCursor: null },
  "api/v1/projects/demo/plans": { plans: [] },
  "api/v1/projects/demo/tasks/t1/live-log": { log: "## step one\n" },
};

interface Rig {
  counts: Map<string, number>;
  sse: { push: (event: object) => void; drop: () => void };
  fetchMock: ReturnType<typeof vi.fn>;
}

function rig({ sseUp = true } = {}): Rig {
  const counts = new Map<string, number>();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const sse = {
    push: (event: object) =>
      controller?.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(event)}\n\n`)),
    drop: () => controller?.close(),
  };
  const fetchMock = vi.fn(async (url: string) => {
    const path = String(url).split("?nonce=")[0];
    const key = String(url).startsWith("healthz") ? "healthz" : path;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (key === "healthz") {
      const nonce = new URL(String(url), "http://ui.local").searchParams.get("nonce")!;
      return new Response(
        JSON.stringify({ ok: true, instanceProof: await instanceProof(INSTANCE, nonce) }),
      );
    }
    if (path === "api/v1/events") {
      if (!sseUp) return new Response("down", { status: 503 });
      return new Response(
        new ReadableStream({
          start(c) {
            controller = c;
            c.enqueue(enc.encode("event: ready\ndata: {}\n\n"));
          },
        }),
        { status: 200, headers: { "X-Boof-Instance": INSTANCE } },
      );
    }
    const body = BODIES[String(url)];
    return body === undefined ? new Response("{}", { status: 404 }) : json(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { counts, sse, fetchMock };
}

function mountMainHooks() {
  return mount(() => {
    // Mirrors App.tsx: the project list feeds the selection that useAppData needs.
    const holder = (globalThis as { __holder?: { id: string | null } }).__holder!;
    const reloadProjects = useCallback(async () => {
      await holderReload.current?.();
    }, []);
    const data = useAppData(holder.id, reloadProjects);
    const projects = useProjects(data.settings, null);
    holderReload.current = projects.reload;
    holder.id = projects.selectedId;
    const overview = useRunnerOverview();
    const step = useRunningStep(projects.selectedId, "t1");
    const held = useHeldScopes();
    const harnesses = useHarnesses();
    return { data, overview, step, held, harnesses, projects };
  });
}
const holderReload: { current: null | (() => Promise<void>) } = { current: null };

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  clearToken();
  resetInstanceProof();
  invalidateCache();
  (globalThis as { __holder?: { id: string | null } }).__holder = { id: null };
  setToken("boof_saved_key");
  sessionStorage.setItem("boofInstance", INSTANCE);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearToken();
});

const MIN = 60_000;
const realSetTimeout = globalThis.setTimeout;

/** Advance fake time in 1 s steps, yielding to the real event loop (WebCrypto is not faked). */
async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 1_000) {
    await vi.advanceTimersByTimeAsync(Math.min(1_000, left));
    await new Promise((r) => realSetTimeout(r, 1));
  }
}

describe("an idle open tab", () => {
  it("stays within the request budget over 10 minutes with the event stream up", async () => {
    const { counts } = rig();
    const app = mountMainHooks();
    await advance(10 * MIN);
    app.unmount();
    const c = (k: string) => counts.get(k) ?? 0;
    expect(c("healthz")).toBeLessThanOrEqual(10);
    expect(c("api/v1/runner/status")).toBeLessThanOrEqual(25);
    for (const k of [
      "api/v1/whoami",
      "api/v1/settings",
      "api/v1/actions",
      "api/v1/projects",
      "api/v1/usage/budget",
      "api/v1/harnesses",
      "api/v1/projects/demo/tasks/t1/live-log",
    ])
      expect(c(k), k).toBeLessThanOrEqual(10);
    expect(c("api/v1/events")).toBeLessThanOrEqual(2);
  });

  it("makes no duplicate calls when the app mounts", async () => {
    const { counts } = rig();
    const app = mountMainHooks();
    await advance(2_000);
    app.unmount();
    for (const k of ["api/v1/whoami", "api/v1/settings", "api/v1/actions", "api/v1/projects"])
      expect(counts.get(k), k).toBe(1);
    expect(counts.get("healthz")).toBe(1);
  });

  it("falls back to 10 s polling when the stream is down, and stays quiet", async () => {
    const { counts } = rig({ sseUp: false });
    const app = mountMainHooks();
    await advance(MIN);
    expect(counts.get("api/v1/runner/status")).toBeGreaterThanOrEqual(5);
    expect(counts.get("api/v1/runner/status")).toBeLessThanOrEqual(8);
    expect(app.result().overview.stale).toBe(false);
    app.unmount();
  });

  it("refreshes the runner overview when a task event arrives", async () => {
    const { counts, sse } = rig();
    const app = mountMainHooks();
    await advance(5_000);
    const before = counts.get("api/v1/runner/status") ?? 0;
    sse.push({ type: "task.status", project: "demo", task: "t1" });
    await advance(2_000);
    expect(counts.get("api/v1/runner/status")).toBe(before + 1);
    app.unmount();
  });

  it("does not fetch while the tab is hidden, and refreshes once when it is visible", async () => {
    const { counts } = rig();
    const listeners: Array<() => void> = [];
    const doc = {
      hidden: false,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: (_: string, fn: () => void) => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
    vi.stubGlobal("document", doc);
    const app = mountMainHooks();
    await advance(5_000);
    doc.hidden = true;
    const before = new Map(counts);
    await advance(5 * MIN);
    expect(counts.get("api/v1/runner/status")).toBe(before.get("api/v1/runner/status"));
    expect(counts.get("healthz")).toBe(before.get("healthz"));
    doc.hidden = false;
    for (const fn of [...listeners]) fn();
    await advance(5_000);
    expect(counts.get("api/v1/runner/status")).toBe((before.get("api/v1/runner/status") ?? 0) + 1);
    app.unmount();
  });

  it("dedupes the update notice checks", async () => {
    const { counts } = rig();
    await Promise.all([getUpdateNotice(), getUpdateNotice(), getUpdateNotice()]);
    expect(counts.get("api/v1/updates")).toBe(1);
  });
});
