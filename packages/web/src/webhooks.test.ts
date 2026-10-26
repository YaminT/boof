import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, AuthStore, defaultSettings, SettingsStore } from "@boof-runner/shared";
import { execCommand, MockTool, ToolRegistry } from "@boof-runner/runner";
import { TaskService } from "@boof-runner/api";
import { createApp } from "./app.js";
import { RETRY_DELAYS_MS, WebhookDispatcher } from "./webhooks.js";

let base: string;
let root: string;
let service: TaskService;
let app: ReturnType<typeof createApp>;
let authStore: AuthStore;
let peer = "127.0.0.1";

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-hooks-")));
  root = join(base, "data");
  await mkdir(root, { recursive: true });
  await new SettingsStore(root).save(defaultSettings());
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  for (const id of ["a", "b"]) {
    const repo = join(base, id);
    await mkdir(repo);
    await execCommand("git", ["init", "-q"], { cwd: repo });
    await service.projects.create({ workingDirectory: repo, id });
  }
  authStore = new AuthStore(root);
  peer = "127.0.0.1";
  app = createApp({
    service,
    authStore,
    peerAddress: () => peer,
    isSelfUrl: (u) => u.hostname === "self.test",
  });
});
afterEach(() => rm(base, { recursive: true, force: true }));

const call = (path: string, init: RequestInit = {}, key?: string) =>
  app.request("http://localhost" + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
  });
const create = async (body: object, key?: string) =>
  call("/api/v1/webhooks", { method: "POST", body: JSON.stringify(body) }, key);

describe("webhook operations", () => {
  it("returns the secret once and never lists it", async () => {
    const res = await create({
      url: "http://127.0.0.1:9/hook",
      events: ["task.*"],
      projects: ["a"],
    });
    expect(res.status).toBe(201);
    const made = await res.json();
    expect(made.secret).toMatch(/^whsec_/);
    expect(made.webhook).toMatchObject({
      events: ["task.*"],
      projects: ["a"],
      enabled: true,
      createdBy: "local",
    });
    expect("secret" in made.webhook).toBe(false);
    const list = await (await call("/api/v1/webhooks")).json();
    expect(JSON.stringify(list)).not.toContain("whsec_");
    expect(list.webhooks).toHaveLength(1);
    expect(JSON.stringify(await (await call("/api/v1/settings")).json())).not.toContain("webhooks");
    expect((await call(`/api/v1/webhooks/${made.webhook.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect((await call(`/api/v1/webhooks/${made.webhook.id}`, { method: "DELETE" })).status).toBe(
      404,
    );
  });

  it("rejects non-http(s) URLs, this server itself and unknown event types", async () => {
    expect((await create({ url: "ftp://example.com/x" })).status).toBe(400);
    expect((await create({ url: "not a url" })).status).toBe(400);
    const self = await create({ url: "http://self.test/api/v1/events" });
    expect(self.status).toBe(400);
    expect((await self.json()).error.message).toMatch(/boof server/);
    expect((await create({ url: "http://example.com/x", events: ["nope.*"] })).status).toBe(400);
  });

  it("is admin only", async () => {
    const { key } = await authStore.create({
      name: "w",
      scopes: ["settings:read", "settings:write", "auth:admin", "tasks:read"],
      trust: "trusted",
    });
    peer = "10.0.0.9";
    expect((await create({ url: "http://example.com/x" }, key)).status).toBe(403);
    expect((await call("/api/v1/webhooks", {}, key)).status).toBe(403);
  });

  it("is not changed by PUT /settings", async () => {
    await create({ url: "http://127.0.0.1:9/hook" });
    await call("/api/v1/settings", {
      method: "PUT",
      body: JSON.stringify({ runner: { enabled: true } }),
    });
    expect(((await service.loadSettings()).webhooks ?? []).length).toBe(1);
    const strict = await call("/api/v1/settings", {
      method: "PUT",
      body: JSON.stringify({ webhooks: [] }),
    });
    expect(strict.status).toBe(400);
  });
});

interface Hit {
  url: string;
  headers: Headers;
  body: string;
}

function harness(answers: (n: number) => number | Error = () => 200) {
  const hits: Hit[] = [];
  let clock = 1_000_000;
  const doFetch = (async (url: string, init: RequestInit) => {
    hits.push({ url, headers: new Headers(init.headers), body: String(init.body) });
    const a = answers(hits.length);
    if (a instanceof Error) throw a;
    return new Response("", { status: a });
  }) as unknown as typeof fetch;
  const dispatcher = new WebhookDispatcher({ root, service, fetch: doFetch, now: () => clock });
  return { hits, dispatcher, advance: (ms: number) => (clock += ms) };
}

const status = (project: string, task: string) => ({
  type: "task.status" as const,
  project,
  task,
  from: "pending",
  to: "running",
  by: "runner",
});

async function subscribe(body: object) {
  const made = await (await create(body)).json();
  return { id: made.webhook.id as string, secret: made.secret as string };
}

describe("webhook delivery", () => {
  it("signs the body, sets the headers and delivers only events after the subscription", async () => {
    await appendEvent(join(root, "projects", "a"), status("a", "old"));
    const { secret } = await subscribe({ url: "http://hook.test/in" });
    const h = harness();
    await h.dispatcher.tick();
    expect(h.hits).toHaveLength(0); // history before the subscription is not sent
    await appendEvent(join(root, "projects", "a"), status("a", "new"));
    await h.dispatcher.tick();
    expect(h.hits).toHaveLength(1);
    const hit = h.hits[0];
    expect(hit.url).toBe("http://hook.test/in");
    const sig = "sha256=" + createHmac("sha256", secret).update(hit.body).digest("hex");
    expect(hit.headers.get("x-boof-signature")).toBe(sig);
    expect(hit.headers.get("x-boof-event")).toBe("task.status");
    const body = JSON.parse(hit.body);
    expect(body).toMatchObject({ type: "task.status", project: "a", task: "new" });
    expect(body.id).toBe(hit.headers.get("x-boof-delivery"));
    await h.dispatcher.tick();
    expect(h.hits).toHaveLength(1); // the cursor moved on
  });

  it("filters by project and event type", async () => {
    await subscribe({ url: "http://hook.test/in", events: ["plan.*"], projects: ["a"] });
    const h = harness();
    await h.dispatcher.tick();
    await appendEvent(join(root, "projects", "a"), status("a", "t"));
    await appendEvent(join(root, "projects", "b"), {
      type: "plan.updated",
      project: "b",
      plan: "p",
      version: 2,
      by: "x",
    });
    await appendEvent(join(root, "projects", "a"), {
      type: "plan.updated",
      project: "a",
      plan: "p",
      version: 2,
      by: "x",
    });
    await appendEvent(root, { type: "runner.enabled", value: true, by: "local" });
    await h.dispatcher.tick();
    expect(h.hits.map((x) => JSON.parse(x.body)).map((b) => `${b.type}:${b.project}`)).toEqual([
      "plan.updated:a",
    ]);
  });

  it("retries on the schedule with one delivery id, then dead-letters", async () => {
    await subscribe({ url: "http://hook.test/in" });
    const h = harness(() => 500);
    await h.dispatcher.tick();
    await appendEvent(join(root, "projects", "a"), status("a", "t"));
    await h.dispatcher.tick();
    expect(h.hits).toHaveLength(1);
    for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
      h.advance(delay - 1);
      await h.dispatcher.tick();
      expect(h.hits).toHaveLength(i + 1); // not due yet
      h.advance(1);
      await h.dispatcher.tick();
      expect(h.hits).toHaveLength(i + 2);
    }
    expect(new Set(h.hits.map((x) => x.headers.get("x-boof-delivery"))).size).toBe(1);
    const dead = await readdir(join(root, "webhooks", "dead"));
    expect(dead).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(root, "webhooks", "dead", dead[0]), "utf8")),
    ).toMatchObject({
      attempts: RETRY_DELAYS_MS.length + 1,
      lastError: "HTTP 500",
      event: { task: "t" },
    });
    h.advance(10 * 3_600_000);
    await h.dispatcher.tick();
    expect(h.hits).toHaveLength(RETRY_DELAYS_MS.length + 1); // nothing left to retry
  });

  it("stops retrying after a success and survives a restart (state file)", async () => {
    await subscribe({ url: "http://hook.test/in" });
    const h = harness((n) => (n === 1 ? new Error("ECONNREFUSED") : 200));
    await h.dispatcher.tick();
    await appendEvent(join(root, "projects", "a"), status("a", "t"));
    await h.dispatcher.tick();
    expect(h.hits).toHaveLength(1);
    const h2 = harness();
    h2.advance(RETRY_DELAYS_MS[0]);
    await h2.dispatcher.tick(); // a fresh dispatcher resumes the pending retry from state.json
    expect(h2.hits).toHaveLength(1);
    await h2.dispatcher.tick();
    expect(h2.hits).toHaveLength(1); // delivered: not retried again
    const state = JSON.parse(await readFile(join(root, "webhooks", "state.json"), "utf8"));
    expect(Object.values(state)).toHaveLength(1);
  });

  it("does not deliver for a disabled webhook", async () => {
    await subscribe({ url: "http://hook.test/in", enabled: false });
    const h = harness();
    await h.dispatcher.tick();
    await appendEvent(join(root, "projects", "a"), status("a", "t"));
    await h.dispatcher.tick();
    expect(h.hits).toHaveLength(0);
  });
});
