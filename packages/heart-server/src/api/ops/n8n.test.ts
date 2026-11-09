import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthStore,
  dataRootPaths,
  LOCAL_PRINCIPAL,
  SettingsStore,
  type Principal,
  type Scope,
} from "@boof/heart";
import { MockTool, ToolRegistry } from "@boof/runner";
import { startFakeN8n, fakeWorkflow } from "../../../test-support/fake-n8n.js";
import type { OpContext } from "../define-op.js";
import { getOp, registry } from "../registry.js";
import { TaskService } from "../services/service.js";

const API_KEY = "n8n-api-key-0123456789";
let root: string;
let service: TaskService;
let fake: Awaited<ReturnType<typeof startFakeN8n>>;
let savedEnv: string | undefined;

const SELF_PORT = "4319";
const isSelfUrl = (u: URL): boolean =>
  (u.port || "80") === SELF_PORT && ["127.0.0.1", "localhost"].includes(u.hostname);

const ctxFor = (principal: Principal): OpContext => ({
  root,
  principal,
  services: service,
  authStore: new AuthStore(root),
  now: () => "2026-01-01T00:00:00.000Z",
  isSelfUrl,
});
const run = (name: string, principal: Principal, input: object = {}) =>
  getOp(name)!.execute(ctxFor(principal), input) as Promise<Record<string, any>>;
const client = (
  scopes: Scope[],
  trust: "trusted" | "review" = "trusted",
  projects: "*" | string[] = "*",
): Principal => ({
  kind: "client",
  id: "c1",
  name: "c1",
  scopes: new Set(scopes),
  projects: projects === "*" ? "*" : new Set(projects),
  trust,
});
const admin = client(["admin", "settings:read", "settings:write"]);

const CALLBACK = "https://boof.example";
const configure = (extra: object = {}) =>
  run("n8n.update", admin, {
    baseUrl: fake.url,
    callbackBaseUrl: CALLBACK,
    apiKey: API_KEY,
    ...extra,
  });

beforeEach(async () => {
  savedEnv = process.env.BOOF_N8N_API_KEY;
  delete process.env.BOOF_N8N_API_KEY;
  root = await mkdtemp(join(tmpdir(), "boof-n8n-ops-"));
  await new SettingsStore(root).save((await import("@boof/heart")).defaultSettings());
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  fake = await startFakeN8n({
    apiKey: API_KEY,
    workflows: [fakeWorkflow({ id: "w1", name: "CI", webhook: { path: "ci" } })],
  });
});
afterEach(async () => {
  if (savedEnv === undefined) delete process.env.BOOF_N8N_API_KEY;
  else process.env.BOOF_N8N_API_KEY = savedEnv;
  await fake.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("n8n.get", () => {
  it("when absent → { configured: false, apiKeySet: false }", async () => {
    const got = await run("n8n.get", admin);
    expect(got).toMatchObject({ configured: false, apiKeySet: false, apiKeySource: null });
    expect(got.webhookSecretSet).toBe(false);
  });
});

describe("n8n.update", () => {
  it("first update needs baseUrl and callbackBaseUrl", async () => {
    await expect(run("n8n.update", admin, { callbackBaseUrl: CALLBACK })).rejects.toMatchObject({
      status: 400,
      details: [expect.objectContaining({ path: "baseUrl" })],
    });
    await expect(run("n8n.update", admin, { baseUrl: fake.url })).rejects.toMatchObject({
      status: 400,
      details: [expect.objectContaining({ path: "callbackBaseUrl" })],
    });
    expect((await run("n8n.get", admin)).configured).toBe(false);
  });

  it("first update returns the webhook secret once; a later update without rotate does not", async () => {
    const first = await configure();
    expect(first.secret).toMatch(/^n8nwh_[0-9a-f]{48}$/);
    expect(first).toMatchObject({ configured: true, apiKeySet: true, apiKeySource: "file" });
    expect(first.webhookSecretSet).toBe(true);
    const stored = JSON.parse(await readFile(dataRootPaths(root).n8nSecrets, "utf8"));
    expect(stored.webhookSecret).toBe(first.secret);
    const second = await run("n8n.update", admin, { defaultTimeoutMs: 60_000 });
    expect(second).not.toHaveProperty("secret");
    expect(second.defaultTimeoutMs).toBe(60_000);
    expect((await run("n8n.get", admin)).defaultTimeoutMs).toBe(60_000);
  });

  it("rotateWebhookSecret returns a new secret", async () => {
    const first = await configure();
    const rotated = await run("n8n.update", admin, { rotateWebhookSecret: true });
    expect(rotated.secret).toMatch(/^n8nwh_/);
    expect(rotated.secret).not.toBe(first.secret);
    expect(await service.n8nSecrets.getWebhookSecret()).toBe(rotated.secret);
  });

  it("the stored settings and ETag-relevant data hold no key or secret", async () => {
    await configure();
    const text = await readFile(join(root, "settings.json"), "utf8");
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain("n8nwh_");
  });

  it("the n8n host itself may be loopback without an allowlist entry (owner answer 2)", async () => {
    expect(fake.url).toContain("127.0.0.1");
    await expect(configure()).resolves.toMatchObject({ configured: true });
  });

  it("O1 a webhookBaseUrl on another private host needs security.allowedPrivateWebhookHosts", async () => {
    await expect(configure({ webhookBaseUrl: "http://127.0.0.1:1/webhook" })).rejects.toMatchObject(
      {
        status: 400,
        message: expect.stringContaining("security.allowedPrivateWebhookHosts"),
      },
    );
    expect((await run("n8n.get", admin)).configured).toBe(false);
  });

  it("O1 link-local and metadata addresses are never exempt", async () => {
    await expect(
      run("n8n.update", admin, { baseUrl: "http://169.254.169.254", callbackBaseUrl: CALLBACK }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("O9 baseUrl pointing at this server → 400", async () => {
    for (const baseUrl of [
      `http://127.0.0.1:${SELF_PORT}`,
      `http://localhost:${SELF_PORT}`,
      `http://[::ffff:127.0.0.1]:${SELF_PORT}`,
    ]) {
      await expect(
        run("n8n.update", admin, { baseUrl, callbackBaseUrl: CALLBACK }),
        baseUrl,
      ).rejects.toMatchObject({ status: 400 });
    }
    expect((await run("n8n.get", admin)).configured).toBe(false);
  });

  it("F1 without a self check the n8n operations refuse (fail closed)", async () => {
    const bare = (name: string, input: object = {}) =>
      getOp(name)!.execute({ ...ctxFor(admin), isSelfUrl: undefined }, input) as Promise<unknown>;
    await expect(
      bare("n8n.update", { baseUrl: `http://127.0.0.1:${SELF_PORT}`, callbackBaseUrl: CALLBACK }),
    ).rejects.toMatchObject({ status: 500, message: expect.stringContaining("own address") });
    await expect(
      bare("n8n.update", { baseUrl: fake.url, callbackBaseUrl: CALLBACK }),
    ).rejects.toMatchObject({ status: 500 });
    await configure();
    await expect(bare("n8n.workflows.refresh")).rejects.toMatchObject({ status: 500 });
    expect(fake.calls).toHaveLength(0);
  });

  it("F4 a changed baseUrl origin drops the stored key and the caches; the same origin keeps them", async () => {
    await configure();
    await run("n8n.workflows.refresh", admin);
    const paths = dataRootPaths(root);
    await writeFile(paths.n8nSeen, "{}");
    const same = await run("n8n.update", admin, { baseUrl: `${fake.url}/` });
    expect(same).toMatchObject({ apiKeySet: true });
    expect(same).not.toHaveProperty("notice");
    await expect(stat(paths.n8nWorkflows)).resolves.toBeDefined();
    const other = await startFakeN8n({ apiKey: API_KEY, workflows: [] });
    try {
      const moved = await run("n8n.update", admin, { baseUrl: other.url });
      expect(moved).toMatchObject({ apiKeySet: false, apiKeySource: null });
      expect(moved.notice).toContain("API key was removed");
      expect(await service.n8nSecrets.getApiKey()).toBeNull();
      await expect(stat(paths.n8nWorkflows)).rejects.toThrow();
      await expect(stat(paths.n8nSeen)).rejects.toThrow();
      expect((await run("n8n.workflows.list", admin)).workflows).toEqual([]);
      // A new key given in the same call is kept.
      await run("n8n.update", admin, { baseUrl: fake.url, apiKey: API_KEY });
      expect(await service.n8nSecrets.getApiKey()).toBe(API_KEY);
    } finally {
      await other.close();
    }
  });

  it("M2 the old key is gone before the new origin is written, so a racing refresh cannot send it", async () => {
    await configure();
    const other = await startFakeN8n({ apiKey: API_KEY, workflows: [] });
    const store = service.settingsStore;
    const realMutate = store.mutate.bind(store);
    let keyAtWrite: string | null | undefined;
    let refreshed: unknown;
    vi.spyOn(store, "mutate").mockImplementation(async (fn) => {
      // The moment just before the settings write: the key must already be dropped.
      keyAtWrite = await service.n8nSecrets.getApiKey();
      const result = await realMutate(fn);
      // The moment just after it: a refresh now reads the new origin and must find no key.
      refreshed = await run("n8n.workflows.refresh", admin).catch((e) => e);
      return result;
    });
    try {
      await run("n8n.update", admin, { baseUrl: other.url, apiKey: "new-key" });
      expect(keyAtWrite).toBeNull();
      expect(other.calls).toHaveLength(0);
      expect(refreshed).toBeDefined();
      expect(await service.n8nSecrets.getApiKey()).toBe("new-key");
    } finally {
      vi.restoreAllMocks();
      await other.close();
    }
  });

  it("a changed baseUrl drops the old exemption for webhookBaseUrl", async () => {
    await configure({ webhookBaseUrl: `${fake.url}/hooks` });
    await expect(run("n8n.update", admin, { baseUrl: "http://127.0.0.1:1" })).rejects.toMatchObject(
      { status: 400 },
    );
  });

  it("O12 settings:write without admin, and a project-restricted admin key, get 403", async () => {
    await configure();
    const noAdmin = client(["settings:read", "settings:write"]);
    const restricted = client(["admin", "settings:read", "settings:write"], "trusted", ["demo"]);
    const review = client(["admin", "settings:read", "settings:write"], "review");
    for (const p of [noAdmin, restricted, review]) {
      for (const [name, input] of [
        ["n8n.update", { defaultTimeoutMs: 20_000 }],
        ["n8n.delete", {}],
      ] as const) {
        await expect(run(name, p, input), `${p.id} ${name}`).rejects.toMatchObject({
          status: 403,
        });
      }
    }
    expect((await run("n8n.get", admin)).defaultTimeoutMs).toBe(1_800_000);
  });

  it("O13 get never returns the key or the secret, over REST ops or MCP", async () => {
    const first = await configure();
    const out = JSON.stringify(await run("n8n.get", admin));
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain(first.secret);
    const { createApp } = await import("../../server/app.js");
    const authStore = new AuthStore(root);
    const key = (
      await authStore.create({
        name: "r",
        scopes: ["admin", "settings:read", "settings:write"],
        trust: "trusted",
      })
    ).key;
    const app = createApp({
      service,
      authStore,
      peerAddress: () => "10.0.0.7",
    });
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${key}`,
    };
    const rpc = (method: string, params: unknown, id: number) =>
      app.request("http://localhost/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
      });
    await rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
      1,
    );
    const tools = await (await rpc("tools/list", {}, 2)).text();
    for (const name of [
      "boof_get_n8n",
      "boof_update_n8n",
      "boof_delete_n8n",
      "boof_list_n8n_workflows",
      "boof_refresh_n8n_workflows",
    ]) {
      expect(tools.includes(`"${name}"`), name).toBe(true);
    }
    const called = await (
      await rpc("tools/call", { name: "boof_get_n8n", arguments: {} }, 3)
    ).text();
    expect(called).toContain("apiKeySet");
    expect(called).not.toContain(API_KEY);
    expect(called).not.toContain(first.secret);
    const http = await app.request("http://localhost/api/v1/n8n", {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(http.status).toBe(200);
    expect(await http.text()).not.toContain(API_KEY);
  });

  it("apiKey null removes it; BOOF_N8N_API_KEY shows apiKeySource env", async () => {
    await configure();
    const removed = await run("n8n.update", admin, { apiKey: null });
    expect(removed).toMatchObject({ apiKeySet: false, apiKeySource: null });
    process.env.BOOF_N8N_API_KEY = "from-env-key-1";
    expect(await run("n8n.get", admin)).toMatchObject({ apiKeySet: true, apiKeySource: "env" });
    const stored = JSON.parse(await readFile(dataRootPaths(root).n8nSecrets, "utf8"));
    expect(stored.apiKey).toBeUndefined();
  });

  it("an invalid apiKey is refused before anything is written", async () => {
    await expect(configure({ apiKey: "has space" })).rejects.toMatchObject({ status: 400 });
    expect((await run("n8n.get", admin)).configured).toBe(false);
  });

  it("checks.projectId must exist", async () => {
    await expect(configure({ checks: { enabled: true, projectId: "nope" } })).rejects.toMatchObject(
      { status: 404 },
    );
    expect((await run("n8n.get", admin)).configured).toBe(false);
    await service.projects.create({
      id: "demo",
      name: "Demo",
      path: { mode: "auto", projectsRoot: `${root}-workspaces` },
    });
    const ok = await configure({ checks: { enabled: true, projectId: "demo" } });
    expect(ok.checks).toEqual({
      enabled: true,
      projectId: "demo",
      autoQueue: false,
      pollIntervalMs: 300_000,
    });
    expect((await run("n8n.update", admin, { checks: null })).checks).toBeUndefined();
  });

  it("settings.get shows no n8n block; PUT /settings with n8n → 400", async () => {
    await configure();
    expect(await run("settings.get", admin)).not.toHaveProperty("n8n");
    await expect(
      run("settings.update", admin, { n8n: { baseUrl: "http://x", callbackBaseUrl: "http://y" } }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await run("n8n.get", admin)).baseUrl).toBe(fake.url);
  });

  it("audit extras name the changed fields and never the key", async () => {
    const extras: Record<string, unknown>[] = [];
    await getOp("n8n.update")!.execute(
      { ...ctxFor(admin), audit: (e) => extras.push(e) },
      { baseUrl: fake.url, callbackBaseUrl: CALLBACK, apiKey: API_KEY },
    );
    const last = extras.at(-1)!;
    expect(last).toMatchObject({
      fields: ["baseUrl", "callbackBaseUrl"],
      apiKey: "set",
      secret: "rotated",
    });
    expect(JSON.stringify(extras)).not.toContain(API_KEY);
  });
});

describe("n8n workflows", () => {
  it("list when absent → { configured: false, workflows: [] }", async () => {
    expect(await run("n8n.workflows.list", admin)).toEqual({
      configured: false,
      fetchedAt: null,
      workflows: [],
    });
  });

  it("refresh when absent → 409 n8n_not_configured", async () => {
    await expect(run("n8n.workflows.refresh", admin)).rejects.toMatchObject({
      status: 409,
      code: "n8n_not_configured",
    });
  });

  it("refresh fills the cache; list reads it without calling n8n (O14)", async () => {
    await configure();
    expect((await run("n8n.workflows.list", admin)).workflows).toEqual([]);
    expect(fake.calls).toHaveLength(0);
    const refreshed = await run("n8n.workflows.refresh", admin);
    expect(refreshed.workflows).toHaveLength(1);
    expect(refreshed.workflows[0]).toMatchObject({ id: "w1", name: "CI" });
    expect(fake.calls.length).toBeGreaterThan(0);
    const calls = fake.calls.length;
    await run("n8n.get", admin);
    const listed = await run("n8n.workflows.list", admin);
    expect(listed.workflows).toHaveLength(1);
    expect(listed.fetchedAt).toBe(refreshed.fetchedAt);
    expect(fake.calls).toHaveLength(calls);
  });

  it("refresh with a wrong key → 502 upstream_failed reason unauthorized; list keeps the old cache with lastError (O10)", async () => {
    await configure();
    await run("n8n.workflows.refresh", admin);
    await run("n8n.update", admin, { apiKey: "wrong-key-0000" });
    await expect(run("n8n.workflows.refresh", admin)).rejects.toMatchObject({
      status: 502,
      code: "upstream_failed",
      details: { reason: "unauthorized" },
    });
    const listed = await run("n8n.workflows.list", admin);
    expect(listed.workflows).toHaveLength(1);
    expect(listed.lastError).toContain("unauthorized");
    expect(JSON.stringify(listed)).not.toContain("wrong-key-0000");
  });

  it("refresh needs settings:write; list needs settings:read", async () => {
    await configure();
    await expect(run("n8n.workflows.refresh", client(["settings:read"]))).rejects.toMatchObject({
      status: 403,
    });
    await expect(run("n8n.workflows.list", client(["tasks:read"]))).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      run("n8n.workflows.refresh", client(["settings:write"], "review")),
    ).resolves.toMatchObject({ configured: true });
  });
});

describe("n8n.delete", () => {
  it("removes settings, secrets and cache and lists projects with steps", async () => {
    await service.projects.create({
      id: "demo",
      name: "Demo",
      path: { mode: "auto", projectsRoot: `${root}-workspaces` },
    });
    await service.projects.create({
      id: "plain",
      name: "Plain",
      path: { mode: "auto", projectsRoot: `${root}-workspaces` },
    });
    await run("projects.update", admin, {
      projectId: "demo",
      externalSteps: [
        { id: "ci", label: "CI", at: "after-developer", workflowId: "w1", webhookPath: "ci" },
      ],
    });
    await configure();
    await run("n8n.workflows.refresh", admin);
    await writeFile(dataRootPaths(root).n8nSeen, "{}");
    const out = await run("n8n.delete", admin);
    expect(out).toEqual({ ok: true, projectsWithSteps: ["demo"] });
    expect((await run("n8n.get", admin)).configured).toBe(false);
    expect(await service.n8nSecrets.getApiKey()).toBeNull();
    const paths = dataRootPaths(root);
    await expect(stat(paths.n8nSecrets)).rejects.toThrow();
    await expect(stat(paths.n8nWorkflows)).rejects.toThrow();
    await expect(stat(paths.n8nSeen)).rejects.toThrow();
    expect((await service.loadSettings()).n8n).toBeUndefined();
    expect((await service.getProject("demo")).externalSteps).toHaveLength(1);
    expect(await readdir(root)).not.toContain("n8n.json");
  });
});

describe("n8n.delete when nothing is configured", () => {
  it("is idempotent", async () => {
    for (let i = 0; i < 2; i++) {
      await expect(run("n8n.delete", admin)).resolves.toEqual({
        ok: true,
        projectsWithSteps: [],
      });
    }
  });
});

describe("externalSteps trust rule", () => {
  const steps = [
    { id: "ci", label: "CI", at: "after-developer", workflowId: "w1", webhookPath: "ci" },
  ];
  beforeEach(async () => {
    await service.projects.create({
      id: "demo",
      name: "Demo",
      path: { mode: "auto", projectsRoot: `${root}-workspaces` },
    });
  });

  it("O11 a review-trust key cannot set or clear externalSteps (403); a trusted key can", async () => {
    const review = client(["projects:write"], "review");
    const trusted = client(["projects:write"], "trusted");
    for (const externalSteps of [steps, null]) {
      await expect(
        run("projects.update", review, { projectId: "demo", externalSteps }),
      ).rejects.toMatchObject({ status: 403, code: "forbidden_trust" });
    }
    expect((await service.getProject("demo")).externalSteps).toBeUndefined();
    const ok = await run("projects.update", trusted, { projectId: "demo", externalSteps: steps });
    expect(ok.externalSteps).toHaveLength(1);
    // Other fields stay open to a review-trust key.
    await expect(
      run("projects.update", review, { projectId: "demo", name: "Renamed" }),
    ).resolves.toMatchObject({ name: "Renamed" });
    await expect(
      run("projects.update", trusted, { projectId: "demo", externalSteps: null }),
    ).resolves.toBeDefined();
    await expect(
      run("projects.update", LOCAL_PRINCIPAL, { projectId: "demo", externalSteps: steps }),
    ).resolves.toBeDefined();
  });

  it("O11 with externalTasksRequireApproval off, the externalSteps rule itself refuses a review key", async () => {
    await service.settingsStore.mutate((s) => ({
      ...s,
      security: { ...(s.security ?? {}), externalTasksRequireApproval: false },
    }));
    const review = client(["projects:write"], "review");
    await expect(
      run("projects.update", review, { projectId: "demo", brief: "Changed" }),
    ).resolves.toBeDefined();
    for (const externalSteps of [steps, null]) {
      await expect(
        run("projects.update", review, { projectId: "demo", externalSteps }),
      ).rejects.toMatchObject({
        status: 403,
        code: "forbidden_trust",
        message: expect.stringContaining("External steps send task content to n8n"),
      });
    }
    expect((await service.getProject("demo")).externalSteps).toBeUndefined();
  });
});

describe("registry", () => {
  it("holds the five n8n operations with the planned REST routes", () => {
    const got = registry
      .filter((o) => o.name.startsWith("n8n."))
      .map((o) => `${o.name} ${o.rest.method} ${o.rest.path} ${o.scope}`);
    expect(got).toEqual([
      "n8n.get GET /n8n settings:read",
      "n8n.update PUT /n8n admin",
      "n8n.delete DELETE /n8n admin",
      "n8n.workflows.list GET /n8n/workflows settings:read",
      "n8n.workflows.refresh POST /n8n/workflows/refresh settings:write",
    ]);
  });
});
