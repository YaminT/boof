import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, defaultSettings, SettingsStore, type Scope } from "@boof-runner/shared";
import { MockTool, ToolRegistry } from "@boof-runner/runner";
import { TaskService } from "@boof-runner/api";
import { createApp } from "./app.js";

let root: string;
let service: TaskService;
let authStore: AuthStore;
let peer: string;
let app: ReturnType<typeof createApp>;

const LOOPBACK = "127.0.0.1";
const REMOTE = "10.1.2.3";
// Names resolve to a public address, except the ones that must be refused.
const resolveHost = async (host: string): Promise<string[]> =>
  host === "internal.example" ? ["10.0.0.5"] : ["93.184.216.34"];

const call = (path: string, init: RequestInit = {}, key?: string) =>
  app.request("http://localhost" + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers as object),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
  });
const send = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function mint(
  scopes: Scope[],
  opts: { projects?: string[] | "*"; trust?: "trusted" | "review"; name?: string } = {},
) {
  return (
    await authStore.create({
      name: opts.name ?? "c",
      scopes,
      projects: opts.projects ?? "*",
      trust: opts.trust ?? "trusted",
    })
  ).key;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-webhook-update-"));
  await mkdir(root, { recursive: true });
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  await new SettingsStore(root).save(defaultSettings());
  authStore = new AuthStore(root);
  peer = LOOPBACK;
  app = createApp({ service, authStore, peerAddress: () => peer, resolveHost });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const make = async (key: string, body: object = {}) => {
  const res = await call(
    "/api/v1/webhooks",
    send("POST", { url: "https://hooks.example/a", events: ["task.*"], ...body }),
    key,
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { webhook: { id: string }; secret: string };
};
const settingsHooks = async () => (await new SettingsStore(root).load()).webhooks ?? [];
const update = (id: string, body: object, key?: string) =>
  call(`/api/v1/webhooks/${id}`, send("PUT", body), key);

describe("event names", () => {
  it("accepts runner.budget_exceeded directly, and still refuses unknown or malformed names", async () => {
    peer = LOOPBACK;
    const ok = await call(
      "/api/v1/webhooks",
      send("POST", { url: "https://hooks.example/a", events: ["runner.budget_exceeded"] }),
    );
    expect(ok.status).toBe(201);
    for (const events of [
      ["runner.no_such_event"],
      ["runner._x"],
      ["Runner.enabled"],
      ["runner.budget__exceeded"],
    ]) {
      const res = await call(
        "/api/v1/webhooks",
        send("POST", { url: "https://hooks.example/a", events }),
      );
      expect(res.status, events[0]).toBe(400);
    }
  });
});

describe("webhooks.update", () => {
  it("edits url, events, projects and enabled; the secret and the creator never change", async () => {
    peer = REMOTE;
    const admin = await mint(["admin"], { name: "boss" });
    const { webhook, secret } = await make(admin);
    const before = (await settingsHooks())[0];
    const res = await update(
      webhook.id,
      {
        url: "https://hooks.example/b",
        events: ["plan.*", "runner.budget_exceeded"],
        projects: ["alpha"],
        enabled: false,
      },
      admin,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: webhook.id,
      url: "https://hooks.example/b",
      events: ["plan.*", "runner.budget_exceeded"],
      projects: ["alpha"],
      enabled: false,
    });
    expect(JSON.stringify(body)).not.toContain("whsec_");
    expect("secret" in body).toBe(false);
    const after = (await settingsHooks())[0];
    expect(after.createdBy).toBe(before.createdBy);
    expect(after.createdByClient).toBe(before.createdByClient);
    expect(after.created).toBe(before.created);
    expect(await service.webhookSecrets.get(webhook.id)).toBe(secret);
  });

  it("changes only what is sent", async () => {
    peer = LOOPBACK;
    const { webhook } = await make("" as never);
    const res = await update(webhook.id, { enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      url: "https://hooks.example/a",
      events: ["task.*"],
      enabled: false,
    });
  });

  it("refuses fields it must never change, an empty edit, and an empty project list", async () => {
    peer = LOOPBACK;
    const { webhook } = await make("" as never);
    for (const body of [
      { createdBy: "x" },
      { createdByClient: true },
      { id: "wh-1" },
      { secret: "s" },
      {},
      { projects: [] },
    ]) {
      const res = await update(webhook.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const create = await call(
      "/api/v1/webhooks",
      send("POST", { url: "https://hooks.example/a", projects: [] }),
    );
    expect(create.status).toBe(400);
  });

  it("applies the URL guard of create: a private name is refused and the webhook stays as it was", async () => {
    peer = LOOPBACK;
    const { webhook } = await make("" as never);
    for (const url of ["http://internal.example/hook", "ftp://hooks.example/x", "not a url"]) {
      const res = await update(webhook.id, { url });
      expect(res.status, url).toBe(400);
    }
    expect((await settingsHooks())[0].url).toBe("https://hooks.example/a");
  });

  it("validates event names like create does", async () => {
    peer = LOOPBACK;
    const { webhook } = await make("" as never);
    expect((await update(webhook.id, { events: ["runner.nope"] })).status).toBe(400);
    expect((await update(webhook.id, { events: ["Bad Event"] })).status).toBe(400);
    expect((await update(webhook.id, { events: ["runner.budget_exceeded"] })).status).toBe(200);
  });

  it("answers 404 for an unknown webhook and 403 without the admin scope", async () => {
    peer = REMOTE;
    const admin = await mint(["admin"], { name: "boss" });
    expect((await update("wh-nope", { enabled: false }, admin)).status).toBe(404);
    const { webhook } = await make(admin);
    const writer = await mint(["settings:write", "tasks:write"], { name: "w" });
    expect((await update(webhook.id, { enabled: false }, writer)).status).toBe(403);
  });

  it("keeps a project-restricted key inside its projects: no widening, and others' webhooks answer 404", async () => {
    peer = REMOTE;
    const boss = await mint(["admin"], { name: "boss" });
    const restricted = await mint(["admin"], { name: "alpha-admin", projects: ["alpha"] });
    const wide = (await make(boss, { projects: "*" })).webhook.id;
    const own = (await make(restricted)).webhook.id; // defaults to its own projects
    expect((await settingsHooks()).find((h) => h.id === own)?.projects).toEqual(["alpha"]);
    expect((await update(wide, { enabled: false }, restricted)).status).toBe(404);
    expect((await update(own, { enabled: false }, restricted)).status).toBe(200);
    const widen = await update(own, { projects: "*" }, restricted);
    expect(widen.status).toBe(403);
    expect((await widen.json()).error.code).toBe("forbidden_project");
    expect((await update(own, { projects: ["alpha", "beta"] }, restricted)).status).toBe(403);
    expect((await update(own, { projects: ["alpha"] }, restricted)).status).toBe(200);
  });

  it("lets a review-trust key edit only the webhooks it created", async () => {
    peer = REMOTE;
    const boss = await mint(["admin"], { name: "boss" });
    const review = await mint(["admin"], { name: "rev", trust: "review" });
    const theirs = (await make(boss)).webhook.id;
    const mine = (await make(review)).webhook.id;
    const refused = await update(theirs, { enabled: false }, review);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("forbidden_trust");
    expect((await update(mine, { enabled: false }, review)).status).toBe(200);
  });
});
