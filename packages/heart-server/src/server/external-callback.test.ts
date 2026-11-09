import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dataRootPaths,
  defaultSettings,
  ExternalRunStore,
  SecuritySettingsSchema,
  SettingsStore,
  type SecuritySettings,
} from "@boof/heart";
import { MockTool, ToolRegistry } from "@boof/runner";
import { TaskService } from "../api/index.js";
import { CALLBACK_BODY_LIMIT, ExternalCallbackBodySchema } from "./external-callback.js";
import { createApp } from "./app.js";
import { startServer } from "./server.js";
import { TEST_LOOPBACK_IS_UI } from "./test-ui-session.js";

let root: string;
let service: TaskService;
let runs: ExternalRunStore;
let peer = "127.0.0.1";
let clock: number;

const DAY = 24 * 3600_000;

/** A store that records the run ids it was asked about (C9: no file is derived from a bad id). */
class SpyStore extends ExternalRunStore {
  verified: string[] = [];
  override async verify(runId: string, token: string | undefined) {
    this.verified.push(runId);
    return super.verify(runId, token);
  }
}

async function setSecurity(patch: Partial<SecuritySettings>): Promise<void> {
  const settings = new SettingsStore(root);
  const current = await settings.load();
  await settings.save({
    ...current,
    security: SecuritySettingsSchema.parse({ ...current.security, ...patch }),
  });
}

function build(store: ExternalRunStore = runs) {
  return createApp({
    service,
    browserSessions: TEST_LOOPBACK_IS_UI,
    peerAddress: () => peer,
    externalRuns: store,
    now: () => clock,
  });
}
let app: ReturnType<typeof build>;

const open = (kind: "step" | "check" = "step", ttlMs = 600_000) =>
  runs.open({ projectId: "shop", taskId: "fix-login", stepId: "ci", kind, ttlMs });

const OK = { status: "ok", report: "all green", summary: "fine" };
const post = (
  runId: string,
  token: string | undefined,
  body: unknown = OK,
  headers: Record<string, string> = {},
  a = app,
) =>
  a.request("http://localhost/callbacks/external-steps/" + runId, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const auditLines = async (): Promise<Record<string, unknown>[]> => {
  const dir = dataRootPaths(root).audit;
  const files = await readdir(dir).catch(() => []);
  const lines: Record<string, unknown>[] = [];
  for (const f of files) {
    for (const l of (await readFile(join(dir, f), "utf8")).split("\n").filter(Boolean)) {
      lines.push(JSON.parse(l));
    }
  }
  return lines.filter((l) => l.action === "callback:external-step");
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-cb-"));
  clock = Date.now();
  peer = "127.0.0.1";
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  await new SettingsStore(root).save(defaultSettings());
  runs = new ExternalRunStore(root, () => clock);
  app = build();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("POST /callbacks/external-steps/{runId}", () => {
  it("C1 valid token and body: 200, result written, run closed, one audit line without the token", async () => {
    const { runId, token } = await open();
    const res = await post(runId, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await runs.result(runId)).toMatchObject(OK);
    expect(await runs.verify(runId, token)).toBeNull();
    const lines = await auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      principal: "external-step",
      kind: "run-token",
      outcome: "ok",
      status: 200,
      runId,
      project: "shop",
      task: "fix-login",
      step: "ci",
      result: "ok",
    });
    const raw = JSON.stringify(lines) + (await readFile(dataRootPaths(root).settings, "utf8"));
    expect(raw).not.toContain(token);
    expect(raw).not.toContain("all green");
  });

  it("C2 a replay of C1 is 401 and the result is unchanged", async () => {
    const { runId, token } = await open();
    expect((await post(runId, token)).status).toBe(200);
    const res = await post(runId, token, { status: "failed", report: "changed" });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("invalid_step_token");
    expect(await runs.result(runId)).toMatchObject(OK);
  });

  it("C3 two valid callbacks in parallel: exactly one 200 and one 401, one result", async () => {
    const { runId, token } = await open();
    const out = await Promise.all([
      post(runId, token, { status: "ok", report: "A" }),
      post(runId, token, { status: "ok", report: "B" }),
    ]);
    expect(out.map((r) => r.status).sort()).toEqual([200, 401]);
    const winner = out[0]!.status === 200 ? "A" : "B";
    expect((await runs.result(runId))?.report).toBe(winner);
  });

  it("C4 a wrong token for a live run is 401; the run stays open and the right token works", async () => {
    const { runId, token } = await open();
    const res = await post(runId, "bxs_" + "A".repeat(43));
    expect(res.status).toBe(401);
    expect(await runs.verify(runId, token)).not.toBeNull();
    expect((await post(runId, token)).status).toBe(200);
  });

  it("C5 the token of run A sent to run B is 401; A stays open", async () => {
    const a = await open();
    const b = await open();
    expect((await post(b.runId, a.token)).status).toBe(401);
    expect(await runs.verify(a.runId, a.token)).not.toBeNull();
    expect(await runs.verify(b.runId, b.token)).not.toBeNull();
  });

  it("C6 a token after expiresAt is 401", async () => {
    const { runId, token } = await open("step", 10_000);
    clock += 10_001;
    expect((await post(runId, token)).status).toBe(401);
  });

  it("C7 a callback after the runner cancelled (timeout or stop) is 401", async () => {
    const { runId, token } = await open();
    expect(await runs.cancel(runId)).toBe(true);
    expect((await post(runId, token)).status).toBe(401);
    expect(await runs.result(runId)).toBeNull();
  });

  it("C8 no Authorization, Basic, and a token in ?token= are all 401", async () => {
    const { runId, token } = await open();
    expect((await post(runId, undefined)).status).toBe(401);
    expect((await post(runId, undefined, OK, { authorization: `Basic ${token}` })).status).toBe(
      401,
    );
    const q = await app.request(
      `http://localhost/callbacks/external-steps/${runId}?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(OK),
      },
    );
    expect(q.status).toBe(401);
    expect(await runs.verify(runId, token)).not.toBeNull();
  });

  it("C9 malformed run ids are 401, are passed raw to verify and touch no file", async () => {
    const spy = new SpyStore(root, () => clock);
    const a = build(spy);
    await mkdir(dataRootPaths(root).externalRuns, { recursive: true });
    const before = await readdir(root);
    for (const id of [encodeURIComponent("../../settings"), "xr-XYZ", "x".repeat(1000)]) {
      expect((await post(id, "bxs_abc", OK, {}, a)).status).toBe(401);
    }
    expect(spy.verified).toEqual(["../../settings", "xr-XYZ", "x".repeat(1000)]);
    expect((await readdir(root)).filter((n) => n !== "audit")).toEqual(before);
    expect(await readdir(dataRootPaths(root).externalRuns)).toEqual([]);
    const lines = await auditLines();
    expect(lines.map((l) => l.runId)).toEqual(["(malformed)", "(malformed)", "(malformed)"]);
  });

  it("C10 a body that fails the schema is 400 and does not use up the token", async () => {
    const { runId, token } = await open();
    const bad = [
      { status: "ok", report: "x", extra: 1 },
      { status: "ok", report: "x".repeat(65_537) },
      { status: "done", report: "x" },
      { status: "ok", report: "x", summary: "s".repeat(301) },
      "not json",
    ];
    for (const body of bad) {
      const res = await post(runId, token, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_input");
    }
    expect((await post(runId, token)).status).toBe(200);
  });

  it("C11 a body over 300 000 bytes is 413 and does not use up the token", async () => {
    const { runId, token } = await open();
    const big = JSON.stringify({ status: "ok", report: "x".repeat(CALLBACK_BODY_LIMIT) });
    const res = await post(runId, token, big);
    expect(res.status).toBe(413);
    expect(await runs.verify(runId, token)).not.toBeNull();
    // Without a declared length the stream is still capped (token valid, so it is read).
    const chunked = await app.request(`http://localhost/callbacks/external-steps/${runId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(chunked.status).toBe(413);
    expect((await post(runId, token)).status).toBe(200);
  });

  it("C12 Content-Type text/plain (or none) is 415", async () => {
    const { runId, token } = await open();
    expect((await post(runId, token, OK, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(runId, token, OK, { "content-type": "" })).status).toBe(415);
    expect(await runs.verify(runId, token)).not.toBeNull();
  });

  it("C13 an Origin or Sec-Fetch-Site header is 403 and the run is untouched", async () => {
    const { runId, token } = await open();
    for (const h of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }]) {
      const res = await post(runId, token, OK, h);
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("origin_not_allowed");
    }
    expect(await runs.verify(runId, token)).not.toBeNull();
  });

  it("C14 the 31st refused call from one address in a minute is 429; another address still works", async () => {
    const { runId, token } = await open();
    for (let i = 0; i < 30; i += 1) {
      expect((await post(runId, "bxs_wrong")).status).toBe(401);
    }
    const limited = await post(runId, "bxs_wrong");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    peer = "203.0.113.7";
    expect((await post(runId, token)).status).toBe(200);
  });

  it("refused browser-shaped, oversized and mistyped requests spend the same budget", async () => {
    await setSecurity({
      rateLimit: { perMinute: 600, attachmentsPerMinute: 30, unauthenticatedPerMinute: 3 },
    });
    const a = build();
    const { runId, token } = await open();
    expect((await post(runId, token, OK, { origin: "https://x.example" }, a)).status).toBe(403);
    expect((await post(runId, token, OK, { "content-type": "text/plain" }, a)).status).toBe(415);
    expect((await post(runId, "bxs_wrong", OK, {}, a)).status).toBe(401);
    expect((await post(runId, "bxs_wrong", OK, {}, a)).status).toBe(429);
  });

  it("C15 auth.mode required with no API key behaves as C1", async () => {
    await setSecurity({ auth: { mode: "required" } });
    const { runId, token } = await open();
    const res = await post(runId, token);
    expect(res.status).toBe(200);
  });

  it("C15b without the token a loopback caller gets no keyless rights", async () => {
    const { runId } = await open();
    peer = "127.0.0.1";
    expect((await post(runId, undefined)).status).toBe(401);
  });

  it("C16 behind nginx (X-Forwarded-For and X-Forwarded-Prefix) it is C1, rate limit keyed by the forwarded client", async () => {
    await setSecurity({
      trustedProxies: ["loopback"],
      rateLimit: { perMinute: 600, attachmentsPerMinute: 30, unauthenticatedPerMinute: 2 },
    });
    const a = build();
    const { runId, token } = await open();
    const fwd = (ip: string) => ({ "x-forwarded-for": ip, "x-forwarded-prefix": "/boof" });
    expect((await post(runId, token, OK, fwd("198.51.100.1"), a)).status).toBe(200);
    const { runId: r2 } = await open();
    expect((await post(r2, "bxs_bad", OK, fwd("198.51.100.1"), a)).status).toBe(401);
    expect((await post(r2, "bxs_bad", OK, fwd("198.51.100.1"), a)).status).toBe(401);
    expect((await post(r2, "bxs_bad", OK, fwd("198.51.100.1"), a)).status).toBe(429);
    expect((await post(r2, "bxs_bad", OK, fwd("198.51.100.2"), a)).status).toBe(401);
  });

  it("the route is reached at /callbacks/... even when a proxy sends X-Forwarded-Prefix: /boof", async () => {
    const { runId, token } = await open();
    expect((await post(runId, token, OK, { "x-forwarded-prefix": "/boof" })).status).toBe(200);
  });

  it("C17 an API key in Authorization never completes a step", async () => {
    const { runId, token } = await open();
    const key = (await service.authStore.create({ name: "k", scopes: ["admin"], trust: "trusted" }))
      .key;
    expect((await post(runId, undefined, OK, { authorization: `Bearer ${key}` })).status).toBe(401);
    expect(await runs.verify(runId, token)).not.toBeNull();
  });

  it("C18 a run token sent to /api/v1/whoami or /mcp is 401", async () => {
    const { token } = await open();
    await setSecurity({ auth: { mode: "required" } });
    const a = build();
    for (const path of ["/api/v1/whoami", "/mcp"]) {
      const res = await a.request("http://localhost" + path, {
        method: path === "/mcp" ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(path === "/mcp" ? { body: "{}" } : {}),
      });
      expect(res.status).toBe(401);
    }
  });

  it("C19 a valid token for a check run is 200 with the same result shape", async () => {
    const { runId, token } = await open("check");
    expect((await post(runId, token)).status).toBe(200);
    expect(await runs.result(runId)).toMatchObject({ ...OK, receivedAt: expect.any(String) });
  });

  it("Content-Type application/json; charset=utf-8 is accepted", async () => {
    const { runId, token } = await open();
    const res = await post(runId, token, OK, { "content-type": "application/json; charset=utf-8" });
    expect(res.status).toBe(200);
  });

  it("refusals audit once each, with no run details before the token verified", async () => {
    const { runId } = await open();
    await post(runId, "bxs_wrong");
    const lines = await auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "invalid_step_token", status: 401, runId });
    expect(lines[0]).not.toHaveProperty("project");
  });

  it("audit can be switched off", async () => {
    await setSecurity({ audit: { enabled: false, retentionDays: 90 } as never });
    const { runId, token } = await open();
    expect((await post(runId, token)).status).toBe(200);
    expect(await auditLines()).toEqual([]);
  });

  it("the schema is strict", () => {
    expect(ExternalCallbackBodySchema.safeParse({ status: "ok", report: "" }).success).toBe(true);
    expect(ExternalCallbackBodySchema.safeParse({ status: "ok", report: "", x: 1 }).success).toBe(
      false,
    );
  });

  it("the server prunes expired runs at start", async () => {
    const old = new ExternalRunStore(root, () => Date.now() - 3 * DAY);
    const stale = await old.open({
      projectId: "p",
      taskId: "t",
      stepId: "s",
      kind: "step",
      ttlMs: 3600_000,
    });
    const live = await open();
    await writeFile(join(dataRootPaths(root).externalRuns, "keep.txt"), "x"); // untouched
    const srv = await startServer({
      catalog: new ToolRegistry([new MockTool()]),
      root,
      port: 0,
      warn: () => {},
    });
    try {
      const names = await readdir(dataRootPaths(root).externalRuns);
      expect(names).not.toContain(stale.runId + ".json");
      expect(names).toContain(live.runId + ".json");
    } finally {
      await srv.stop();
    }
  });
});
