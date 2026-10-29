import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  AuthStore,
  defaultSettings,
  SecuritySettingsSchema,
  SettingsStore,
  WebhookSecretStore,
  type SecuritySettings,
} from "@boof-runner/shared";
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

const dns: Record<string, string[]> = {};
const resolveHost = async (host: string): Promise<string[]> => {
  const a = dns[host];
  if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return a;
};
async function setSecurity(patch: Partial<SecuritySettings>): Promise<void> {
  const settings = new SettingsStore(root);
  const current = await settings.load();
  await settings.save({
    ...current,
    security: SecuritySettingsSchema.parse({ ...current.security, ...patch }),
  });
}

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
  for (const k of Object.keys(dns)) delete dns[k];
  dns["hook.test"] = ["93.184.216.34"];
  authStore = new AuthStore(root);
  peer = "127.0.0.1";
  app = createApp({
    service,
    authStore,
    peerAddress: () => peer,
    isSelfUrl: (u) => u.hostname === "self.test",
    resolveHost,
  });
});
afterEach(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

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
      url: "http://hook.test/hook",
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
    expect(await readFile(join(root, "settings.json"), "utf8")).not.toContain("whsec_");
    expect(JSON.stringify(await service.loadSettings())).not.toContain("whsec_");
    expect(await new WebhookSecretStore(root).get(made.webhook.id)).toBe(made.secret);
    const list = await (await call("/api/v1/webhooks")).json();
    expect(JSON.stringify(list)).not.toContain("whsec_");
    expect(list.webhooks).toHaveLength(1);
    expect(JSON.stringify(await (await call("/api/v1/settings")).json())).not.toContain("webhooks");
    expect((await call(`/api/v1/webhooks/${made.webhook.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect(await new WebhookSecretStore(root).get(made.webhook.id)).toBeNull();
    expect((await call(`/api/v1/webhooks/${made.webhook.id}`, { method: "DELETE" })).status).toBe(
      404,
    );
  });

  it("keeps a concurrent runner toggle and every concurrent webhook create", async () => {
    const urls = ["http://hook.test/a", "http://hook.test/b", "http://hook.test/c"];
    for (let round = 0; round < 5; round++) {
      const before = ((await service.loadSettings()).webhooks ?? []).length;
      const enabled = round % 2 === 0;
      const results = await Promise.all([
        ...urls.map((url) => create({ url })),
        service.settingsStore.update({ runner: { enabled } }),
      ]);
      expect(results.slice(0, 3).map((r) => (r as Response).status)).toEqual([201, 201, 201]);
      const after = await service.loadSettings();
      expect(after.runner.enabled).toBe(enabled);
      expect((after.webhooks ?? []).length).toBe(before + 3);
    }
  });

  it("keeps a concurrent runner toggle when a webhook is deleted", async () => {
    const made = await (await create({ url: "http://hook.test/hook" })).json();
    const [res] = await Promise.all([
      call(`/api/v1/webhooks/${made.webhook.id}`, { method: "DELETE" }),
      service.settingsStore.update({ runner: { enabled: true } }),
    ]);
    expect(res.status).toBe(200);
    const after = await service.loadSettings();
    expect(after.runner.enabled).toBe(true);
    expect(after.webhooks ?? []).toHaveLength(0);
  });

  it("rejects non-http(s) URLs, this server itself and unknown event types", async () => {
    expect((await create({ url: "ftp://example.com/x" })).status).toBe(400);
    expect((await create({ url: "not a url" })).status).toBe(400);
    const self = await create({ url: "http://self.test/api/v1/events" });
    expect(self.status).toBe(400);
    expect((await self.json()).error.message).toMatch(/boof server/);
    expect((await create({ url: "http://hook.test/x", events: ["nope.*"] })).status).toBe(400);
  });

  it("rejects loopback, link-local, private, CGNAT, multicast, mapped and NAT64 literals", async () => {
    for (const url of [
      "http://127.0.0.1:9/hook",
      "http://127.1/x",
      "http://0x7f000001/x",
      "http://2130706433/x",
      "http://localhost:8080/x",
      "http://foo.localhost/x",
      "http://[::1]/x",
      "http://[::ffff:10.0.0.5]/x",
      "http://[64:ff9b::7f00:1]/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5:9200/_bulk",
      "http://172.16.0.1/x",
      "http://192.168.1.1/x",
      "http://100.64.0.1/x",
      "http://0.0.0.0/x",
      "http://224.0.0.1/x",
      "http://[fe80::1]/x",
      "http://[fd00::1]/x",
      "http://[::7f00:1]/x", // IPv4-compatible
      "http://[::ffff:0:a00:5]/x", // SIIT
      "http://[fec0::1]/x",
      "http://[100::1]/x",
      "http://[64:ff9b:1::1]/x", // local-use NAT64
      "http://[2002:7f00:1::]/x", // 6to4 of 127.0.0.1
      "http://[2002:a00:5::1]/x", // 6to4 of 10.0.0.5
    ]) {
      const res = await create({ url });
      expect(res.status, url).toBe(400);
      expect((await res.json()).error.details[0].path, url).toBe("url");
    }
    expect((await create({ url: "http://[2002:5db8:d822::1]/x" })).status).toBe(201); // 6to4 of a public address
    expect((await create({ url: "http://93.184.216.34/x" })).status).toBe(201);
    expect((await create({ url: "http://[2606:2800:220:1:248:1893:25c8:1946]/x" })).status).toBe(
      201,
    );
  });

  it("resolves the host at creation and refuses names that point inside", async () => {
    dns["internal.test"] = ["10.0.0.5"];
    dns["sixtofour.test"] = ["2002:a00:5::1"];
    dns["sitelocal.test"] = ["fec0::1"];
    expect((await create({ url: "https://sixtofour.test/x" })).status).toBe(400);
    expect((await create({ url: "https://sitelocal.test/x" })).status).toBe(400);
    dns["mixed.test"] = ["93.184.216.34", "127.0.0.1"];
    const res = await create({ url: "https://internal.test/hook" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.details).toEqual([
      { path: "url", message: "10.0.0.5 is private" },
    ]);
    expect((await create({ url: "https://mixed.test/hook" })).status).toBe(400);
    const unknown = await create({ url: "https://unknown.test/hook" });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.details[0].message).toMatch(/does not resolve/);
    expect((await create({ url: "https://hook.test/hook" })).status).toBe(201);
  });

  it("security.allowedPrivateWebhookHosts lets a named private endpoint through", async () => {
    dns["internal.test"] = ["10.0.0.5"];
    await setSecurity({ allowedPrivateWebhookHosts: ["127.0.0.1", "Internal.test"] });
    expect((await create({ url: "http://127.0.0.1:9/hook" })).status).toBe(201);
    expect((await create({ url: "http://internal.test/hook" })).status).toBe(201);
    expect((await create({ url: "http://10.0.0.6/hook" })).status).toBe(400);
    await setSecurity({ allowedPrivateWebhookHosts: ["*"] });
    expect((await create({ url: "http://10.0.0.6/hook" })).status).toBe(201);
  });

  it("is admin only", async () => {
    const { key } = await authStore.create({
      name: "w",
      scopes: ["settings:read", "settings:write", "auth:admin", "tasks:read"],
      trust: "trusted",
    });
    peer = "10.0.0.9";
    expect((await create({ url: "http://hook.test/x" }, key)).status).toBe(403);
    expect((await call("/api/v1/webhooks", {}, key)).status).toBe(403);
  });

  it("is not changed by PUT /settings", async () => {
    await create({ url: "http://hook.test/hook" });
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
  redirect: RequestRedirect | undefined;
}

function harness(answers: (n: number) => number | Error = () => 200) {
  const hits: Hit[] = [];
  let clock = 1_000_000;
  const doFetch = (async (url: string, init: RequestInit) => {
    hits.push({
      url,
      headers: new Headers(init.headers),
      body: String(init.body),
      redirect: init.redirect,
    });
    const a = answers(hits.length);
    if (a instanceof Error) throw a;
    return new Response("", { status: a });
  }) as unknown as typeof fetch;
  const dispatcher = new WebhookDispatcher({
    root,
    service,
    fetch: doFetch,
    now: () => clock,
    resolveHost,
  });
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
  it("does not deliver a webhook whose secret is missing from the file", async () => {
    const { id } = await subscribe({ url: "http://hook.test/in" });
    const h = harness();
    await h.dispatcher.tick();
    await new WebhookSecretStore(root).delete(id);
    await appendEvent(join(root, "projects", "a"), status("a", "t"));
    await h.dispatcher.tick();
    expect(h.hits).toHaveLength(0);
    const state = JSON.parse(await readFile(join(root, "webhooks", "state.json"), "utf8"));
    expect(state[id].pending[0].lastError).toBe(
      `no signing secret for ${id} in webhooks/secrets.json`,
    );
  });

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

  it("re-resolves at delivery: a host rebound to a private address is never posted to", async () => {
    const { id } = await subscribe({ url: "http://hook.test/in" });
    const h = harness();
    await h.dispatcher.tick();
    dns["hook.test"] = ["127.0.0.1"];
    await appendEvent(join(root, "projects", "a"), status("a", "t"));
    await h.dispatcher.tick();
    expect(h.hits).toHaveLength(0);
    const state = JSON.parse(await readFile(join(root, "webhooks", "state.json"), "utf8"));
    expect(state[id].pending).toHaveLength(1);
    expect(state[id].pending[0].lastError).toBe("blocked: 127.0.0.1 is loopback");
    dns["hook.test"] = ["93.184.216.34"];
    h.advance(RETRY_DELAYS_MS[0]);
    await h.dispatcher.tick();
    expect(h.hits).toHaveLength(1); // delivered once the name is public again, same delivery id
    expect(h.hits[0].headers.get("x-boof-delivery")).toBe(state[id].pending[0].deliveryId);
  });

  it("treats a 3xx answer as a failed attempt and does not follow it", async () => {
    const { id } = await subscribe({ url: "http://hook.test/in" });
    const h = harness(() => 302);
    await h.dispatcher.tick();
    await appendEvent(join(root, "projects", "a"), status("a", "t"));
    await h.dispatcher.tick();
    expect(h.hits).toHaveLength(1);
    expect(h.hits[0].redirect).toBe("manual");
    const state = JSON.parse(await readFile(join(root, "webhooks", "state.json"), "utf8"));
    expect(state[id].pending[0].lastError).toBe("HTTP 302");
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
