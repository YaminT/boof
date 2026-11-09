import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultSettings,
  N8nSecretStore,
  N8nSettingsSchema,
  SettingsStore,
  type ExternalTriggerRequest,
} from "@boof/heart";
import { notSelf, startFakeN8n, type FakeN8nCall } from "../../test-support/fake-n8n.js";
import { createN8nTransport, NO_SERVER_MESSAGE } from "./transport.js";

let root: string;
const closers: (() => Promise<void>)[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-n8n-transport-"));
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await rm(root, { recursive: true, force: true });
});

async function configure(n8n: Record<string, unknown> | null): Promise<void> {
  await new SettingsStore(root).save({
    ...defaultSettings(),
    ...(n8n
      ? { n8n: N8nSettingsSchema.parse({ callbackBaseUrl: "https://boof.example", ...n8n }) }
      : {}),
  });
}

async function fake(onWebhook?: Parameters<typeof startFakeN8n>[0]["onWebhook"]) {
  const f = await startFakeN8n({ apiKey: "k", onWebhook });
  closers.push(f.close);
  return f;
}

const req = (over: Partial<ExternalTriggerRequest> = {}): ExternalTriggerRequest => ({
  projectId: "shop",
  taskId: "fix-login",
  stepId: "ci",
  runId: "xr-" + "b".repeat(32),
  workflowId: "wf42",
  webhookPath: "0123456789-secret-uuid",
  signal: new AbortController().signal,
  payload: {
    boof: { version: "0.4.0", kind: "step" },
    run: {
      id: "xr-" + "b".repeat(32),
      callbackUrl: "https://x/cb",
      token: "bxs_t",
      expiresAt: "2026-11-09T12:00:00.000Z",
    },
    step: { id: "ci", label: "CI", at: "after-developer" },
    task: {
      project: "shop",
      id: "fix-login",
      title: "t",
      prompt: "p",
      labels: [],
      priority: 0,
      iteration: 1,
    },
    reports: {},
  },
  ...over,
});

const make = (extra: Partial<Parameters<typeof createN8nTransport>[0]> = {}) =>
  createN8nTransport({
    root,
    env: {},
    isSelfUrl: notSelf,
    serverRunning: async () => true,
    ...extra,
  });

describe("n8n transport", () => {
  it("preflight: not configured; no server; ok", async () => {
    await configure(null);
    expect(await make().preflight()).toBe("n8n is not configured");
    await configure({ baseUrl: "http://127.0.0.1:5678" });
    expect(await make({ serverRunning: async () => false }).preflight()).toBe(NO_SERVER_MESSAGE);
    expect(NO_SERVER_MESSAGE).toMatch(/start boof-runner serve or the desktop app/);
    expect(await make().preflight()).toBeNull();
  });

  it("preflight without the seam reads the dispatcher lock of the data root (none held)", async () => {
    await configure({ baseUrl: "http://127.0.0.1:5678" });
    expect(await createN8nTransport({ root, env: {}, isSelfUrl: notSelf }).preflight()).toBe(
      NO_SERVER_MESSAGE,
    );
  });

  it("not configured → trigger fails without a request", async () => {
    await configure(null);
    expect(await make().trigger(req())).toEqual({
      ok: false,
      retryable: false,
      reason: "n8n is not configured",
    });
  });

  it("2xx → answered; the request carries the payload and the headers; the webhook on the n8n host:port needs no allowlist", async () => {
    const f = await fake();
    await configure({ baseUrl: f.url });
    const secret = await new N8nSecretStore(root, {}).rotateWebhookSecret();
    expect(await make().trigger(req())).toEqual({ ok: true, sent: "answered" });
    const call = f.calls[0] as FakeN8nCall;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/webhook/0123456789-secret-uuid");
    expect(call.headers).toMatchObject({
      "content-type": "application/json",
      "user-agent": "boof-runner-n8n",
      "x-boof-token": secret,
      "x-boof-run": "xr-" + "b".repeat(32),
    });
    expect(call.body).toMatchObject({ run: { token: "bxs_t" }, step: { id: "ci" } });
  });

  it("no webhook secret → no X-Boof-Token header", async () => {
    const f = await fake();
    await configure({ baseUrl: f.url });
    await make().trigger(req());
    expect(f.calls[0]!.headers["x-boof-token"]).toBeUndefined();
  });

  it("503 → retryable; ECONNREFUSED → retryable unreachable; 400 → not retryable; 302 → redirected", async () => {
    const status = { value: 503 };
    const f = await fake(() => ({ status: status.value }));
    await configure({ baseUrl: f.url });
    const t = make();
    expect(await t.trigger(req())).toEqual({ ok: false, retryable: true, reason: "HTTP 503" });
    status.value = 400;
    expect(await t.trigger(req())).toEqual({ ok: false, retryable: false, reason: "HTTP 400" });
    status.value = 302;
    expect(await t.trigger(req())).toEqual({ ok: false, retryable: false, reason: "redirected" });
    expect(f.calls).toHaveLength(3);
    await f.close();
    expect(await t.trigger(req())).toEqual({ ok: false, retryable: true, reason: "unreachable" });
  });

  it("404 explains an inactive workflow", async () => {
    const f = await fake(() => ({ status: 404 }));
    await configure({ baseUrl: f.url });
    const res = await make().trigger(req());
    expect(res).toEqual({
      ok: false,
      retryable: false,
      reason:
        "n8n answered 404 for workflow wf42: is it active, and is the webhook path 01234567… still right?",
    });
    expect(JSON.stringify(res)).not.toContain("secret-uuid");
  });

  it("a slow webhook that got the body → timed-out-after-send", async () => {
    const f = await fake(() => ({ status: 200, delayMs: 1_500 }));
    await configure({ baseUrl: f.url });
    const res = await make({ timeouts: { triggerMs: 150 } }).trigger(req());
    expect(res).toEqual({ ok: true, sent: "timed-out-after-send" });
    expect(f.calls).toHaveLength(1);
  });

  it("a stop request aborts the trigger without a retry", async () => {
    const stop = new AbortController();
    // The stop lands once the webhook has the request (still unanswered), not on a timer.
    const f = await fake(() => {
      stop.abort();
      return { status: 200, delayMs: 1_500 };
    });
    await configure({ baseUrl: f.url });
    expect(await make().trigger(req({ signal: stop.signal }))).toEqual({
      ok: false,
      retryable: false,
      reason: "stopped",
    });
  });

  it("a blocked target (webhook host that is not the n8n host) is not retryable and sends nothing", async () => {
    const f = await fake();
    const hooks = await fake();
    await configure({ baseUrl: f.url, webhookBaseUrl: `${hooks.url}/webhook` });
    const res = await make().trigger(req());
    expect(res).toMatchObject({ ok: false, retryable: false });
    expect((res as { reason: string }).reason).toMatch(/^blocked: 127\.0\.0\.1 is loopback$/);
    expect(hooks.calls).toHaveLength(0);
  });

  it("boof's own address is refused as a webhook target even on the n8n host:port", async () => {
    const f = await fake();
    await configure({ baseUrl: f.url });
    const res = await make({ isSelfUrl: () => true }).trigger(req());
    expect(res).toMatchObject({ ok: false, retryable: false });
    expect((res as { reason: string }).reason).toMatch(/^blocked: /);
    expect(f.calls).toHaveLength(0);
  });

  it("F3: a webhook path with .. or . segments is refused before any request", async () => {
    const f = await fake();
    await configure({ baseUrl: f.url });
    for (const webhookPath of ["../../api/v1/workflows", "a/../b", "a/./b", "./x", "/abs"]) {
      const res = await make().trigger(req({ webhookPath }));
      expect(res, webhookPath).toEqual({
        ok: false,
        retryable: false,
        reason: "invalid webhook path",
      });
    }
    expect(f.calls).toHaveLength(0);
  });

  it("one audit line per trigger with host, project, task, step, runId and no path", async () => {
    const f = await fake();
    await configure({ baseUrl: f.url });
    await make().trigger(req());
    const files = await readdir(join(root, "audit"));
    const text = (await readFile(join(root, "audit", files[0]!), "utf8")).trim();
    const lines = text.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      action: "n8n:trigger",
      via: "server",
      outcome: "ok",
      host: new URL(f.url).host,
      httpStatus: 200,
      project: "shop",
      task: "fix-login",
      step: "ci",
      runId: "xr-" + "b".repeat(32),
    });
    expect(text).not.toContain("secret-uuid");
    expect(text).not.toContain("bxs_t");
  });

  it("the runner variant audits via runner", async () => {
    const f = await fake();
    await configure({ baseUrl: f.url });
    await make({ via: "runner" }).trigger(req());
    const files = await readdir(join(root, "audit"));
    const line = JSON.parse((await readFile(join(root, "audit", files[0]!), "utf8")).trim());
    expect(line).toMatchObject({ via: "runner", principal: "runner", kind: "runner" });
  });
});
