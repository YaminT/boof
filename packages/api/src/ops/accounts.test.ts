import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, LOCAL_PRINCIPAL, type Principal, type Scope } from "@boof-runner/shared";
import { MockTool, ToolRegistry } from "@boof-runner/runner";
import { LOCAL_MCP_PRINCIPAL } from "../local-principal.js";
import type { OpContext } from "../define-op.js";
import { OpError } from "../errors.js";
import { getOp } from "../registry.js";
import { TaskService } from "../services/service.js";

const KEY = "btr-test-key-0123456789";
let root: string;
let server: Server;
let url: string;
let seen: { method: string; url: string; key?: string; body: string }[];
let healthBody: object;
let healthStatus: number;
let accountStatus: number;

const svcFor = () => new TaskService(root, new ToolRegistry([new MockTool()]));
let service: TaskService;
const ctxFor = (principal: Principal): OpContext => ({
  root,
  principal,
  services: service,
  authStore: new AuthStore(root),
  now: () => "2026-01-01T00:00:00.000Z",
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
const admin = client(["settings:read", "settings:write"]);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-accounts-"));
  seen = [];
  healthStatus = 200;
  accountStatus = 200;
  healthBody = {
    status: "ok",
    pool: {
      configured: 2,
      routable: 2,
      paused: 0,
      rate_limited: 0,
      usage_exhausted: 0,
      next_available_at: null,
    },
  };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method!,
        url: req.url!,
        key: req.headers["x-api-key"] as string | undefined,
        body: Buffer.concat(chunks).toString(),
      });
      res.setHeader("content-type", "application/json");
      if (req.url === "/health")
        return void res.writeHead(healthStatus).end(JSON.stringify(healthBody));
      if (req.url === "/api/accounts") {
        return void res
          .writeHead(accountStatus)
          .end(
            JSON.stringify([
              { id: "a1", name: "Main", provider: "claude-oauth", priority: 0, paused: false },
            ]),
          );
      }
      res.writeHead(accountStatus).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  service = svcFor();
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function configure(withKey = true) {
  await run("settings.update", LOCAL_PRINCIPAL, {
    owlish: { url, healthGate: "pause" },
    ...(withKey ? { owlishApiKey: KEY } : {}),
  });
  seen = [];
}

describe("registration", () => {
  it("six operations with REST, MCP and the scopes the design names", () => {
    const table: [string, string, string, string, Scope][] = [
      ["accounts.list", "GET", "/accounts", "boof_list_accounts", "settings:read"],
      ["accounts.health", "GET", "/accounts/health", "boof_get_pool_health", "settings:read"],
      [
        "accounts.pause",
        "POST",
        "/accounts/{accountId}/pause",
        "boof_pause_account",
        "settings:write",
      ],
      [
        "accounts.resume",
        "POST",
        "/accounts/{accountId}/resume",
        "boof_resume_account",
        "settings:write",
      ],
      [
        "accounts.priority",
        "POST",
        "/accounts/{accountId}/priority",
        "boof_set_account_priority",
        "settings:write",
      ],
      [
        "accounts.thresholds",
        "POST",
        "/accounts/{accountId}/thresholds",
        "boof_set_account_thresholds",
        "settings:write",
      ],
    ];
    for (const [name, method, path, tool, scope] of table) {
      const op = getOp(name);
      expect(op, name).toBeDefined();
      expect(op!.rest).toMatchObject({ method, path });
      expect(op!.mcp).toMatchObject({ expose: true, name: tool });
      expect(op!.scopes).toEqual([scope]);
      expect(op!.projectScoped).toBe(false);
    }
  });
});

describe("without a gateway configured", () => {
  it("health is absent and no request is made; list is empty; mutations say it is not configured", async () => {
    const h = await run("accounts.health", admin);
    expect(h).toMatchObject({
      configured: false,
      url: null,
      keySource: null,
      pool: { status: "absent", reason: null },
    });
    expect(await run("accounts.list", admin)).toEqual({ configured: false, accounts: [] });
    const err = await run("accounts.pause", admin, { accountId: "a1" }).catch((e) => e);
    expect(err).toBeInstanceOf(OpError);
    expect(err).toMatchObject({ status: 409, code: "not_configured" });
    expect(seen).toEqual([]);
  });

  it("runner.status carries pool: absent", async () => {
    expect((await run("runner.status", admin)).pool).toMatchObject({ status: "absent" });
    expect((await run("runner.overview", admin)).pool).toMatchObject({ status: "absent" });
  });
});

describe("with a gateway", () => {
  it("rejects an invalid key without changing settings", async () => {
    await service.settingsStore.save({
      ...(await service.loadSettings()),
      defaultProject: "before",
    });
    const before = await readFile(join(root, "settings.json"), "utf8");
    await run("settings.update", LOCAL_PRINCIPAL, {
      owlish: { url },
      owlishApiKey: "has space",
    }).catch(() => undefined);
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe(before);
  });

  it("refuses dot traversal account ids before calling the gateway", async () => {
    await configure();
    for (const accountId of [".", "..", "x/y"]) {
      await run("accounts.pause", admin, { accountId }).catch(() => undefined);
    }
    expect(seen.filter((r) => r.url.includes("/api/"))).toEqual([]);
  });
  it("settings.update stores url and gate in settings, the key only in the secret store", async () => {
    await configure();
    const settings = await readFile(join(root, "settings.json"), "utf8");
    expect(settings).toContain(url);
    expect(settings).not.toContain(KEY);
    expect(await service.owlishSecrets.get()).toBe(KEY);
    expect(await readFile(join(root, "owlish", "secrets.json"), "utf8")).toContain(KEY);
  });

  it("settings.update output and settings.get never carry the key", async () => {
    const out = await run("settings.update", LOCAL_PRINCIPAL, {
      owlish: { url },
      owlishApiKey: KEY,
    });
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(JSON.stringify(await run("settings.get", admin))).not.toContain(KEY);
    expect(JSON.stringify(await run("accounts.health", admin))).not.toContain(KEY);
  });

  it("owlish: null clears the gateway; owlishApiKey: null removes the stored key", async () => {
    await configure();
    await run("settings.update", LOCAL_PRINCIPAL, { owlish: null, owlishApiKey: null });
    expect((await run("accounts.health", admin)).configured).toBe(false);
    expect(await service.owlishSecrets.get()).toBeNull();
    expect((await run("settings.get", admin)).owlish).toBeUndefined();
  });

  it("accounts.health reports the pool, the host of the url, and where the key comes from", async () => {
    await configure();
    const h = await run("accounts.health", admin);
    expect(h).toMatchObject({
      configured: true,
      url: new URL(url).origin,
      healthGate: "pause",
      keySource: "file",
      pool: { status: "ok", configured: 2, routable: 2 },
    });
    expect(seen.map((s) => s.url)).toEqual(["/health"]);
    expect(seen[0]!.key).toBeUndefined();
  });

  it("a degraded or unreachable pool is reported with its reason, never throws", async () => {
    await configure();
    healthStatus = 503;
    healthBody = {
      status: "degraded",
      pool: {
        configured: 2,
        routable: 0,
        paused: 0,
        rate_limited: 2,
        usage_exhausted: 0,
        next_available_at: "2026-11-04T00:00:00Z",
      },
    };
    // A fresh service so the 10 s health cache is empty.
    service = svcFor();
    const h = await run("accounts.health", admin);
    expect(h.pool).toMatchObject({
      status: "degraded",
      routable: 0,
      nextAvailableAt: "2026-11-04T00:00:00.000Z",
    });
    expect(h.pool.reason).toMatch(/degraded/);
    await run("settings.update", LOCAL_PRINCIPAL, { owlish: { url: "http://127.0.0.1:1" } });
    service = svcFor();
    expect((await run("accounts.health", admin)).pool.status).toBe("unreachable");
  });

  it("runner.status and runner.overview include the live pool", async () => {
    await configure();
    expect((await run("runner.status", admin)).pool).toMatchObject({ status: "ok", routable: 2 });
    expect((await run("runner.overview", admin)).pool).toMatchObject({ status: "ok" });
  });

  it("list returns the gateway's accounts, sending the key", async () => {
    await configure();
    const out = await run("accounts.list", admin);
    expect(out).toMatchObject({
      configured: true,
      accounts: [{ id: "a1", name: "Main", provider: "claude-oauth", priority: 0, paused: false }],
    });
    expect(seen).toEqual([
      expect.objectContaining({ method: "GET", url: "/api/accounts", key: KEY }),
    ]);
  });

  it("pause, resume, priority and thresholds call the gateway as an admin", async () => {
    await configure();
    await run("accounts.pause", admin, { accountId: "a1" });
    await run("accounts.resume", admin, { accountId: "a1" });
    await run("accounts.priority", admin, { accountId: "a1", priority: 5 });
    await run("accounts.thresholds", admin, {
      accountId: "a1",
      thresholds: { fiveHour: 80, weekly: null },
    });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST /api/accounts/a1/pause",
      "POST /api/accounts/a1/resume",
      "POST /api/accounts/a1/priority",
      "POST /api/accounts/a1/usage-pause-thresholds",
    ]);
    expect(JSON.parse(seen[2]!.body)).toEqual({ priority: 5 });
    expect(JSON.parse(seen[3]!.body)).toEqual({ fiveHour: 80, weekly: null });
    expect(seen.every((s) => s.key === KEY)).toBe(true);
  });

  it("validates input: priority 0-100, thresholds 0-100 percents, strict objects", async () => {
    await configure();
    for (const input of [
      { accountId: "a1", priority: 101 },
      { accountId: "a1", priority: -1 },
      { accountId: "a1", priority: 1.5 },
      { accountId: "a1", priority: 1, extra: 1 },
    ]) {
      await expect(run("accounts.priority", admin, input)).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      run("accounts.thresholds", admin, { accountId: "a1", thresholds: { fiveHour: 120 } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      run("settings.update", LOCAL_PRINCIPAL, { owlish: { url: "ftp://x" } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(seen).toEqual([]);
  });

  it("a gateway error becomes 502 gateway_error without the key or the body", async () => {
    await configure();
    accountStatus = 401;
    for (const call of [
      () => run("accounts.list", admin),
      () => run("accounts.pause", admin, { accountId: "a1" }),
    ]) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(OpError);
      expect(err).toMatchObject({ status: 502, code: "gateway_error" });
      expect(String(err.message)).not.toContain(KEY);
      expect(String(err.message)).toMatch(/401/);
    }
  });
});

describe("authorization", () => {
  it("reads need settings:read; mutations and gateway configuration need settings:write", async () => {
    await configure();
    const reader = client(["settings:read"]);
    expect((await run("accounts.list", reader)).configured).toBe(true);
    seen = [];
    for (const [name, input] of [
      ["accounts.pause", { accountId: "a1" }],
      ["accounts.resume", { accountId: "a1" }],
      ["accounts.priority", { accountId: "a1", priority: 1 }],
      ["accounts.thresholds", { accountId: "a1", thresholds: {} }],
      ["settings.update", { owlish: { url: "http://127.0.0.1:9" } }],
    ] as const) {
      await expect(run(name, reader, input), name).rejects.toMatchObject({ status: 403 });
    }
    const none = client(["tasks:read"]);
    await expect(run("accounts.list", none)).rejects.toMatchObject({ status: 403 });
    await expect(run("accounts.health", none)).rejects.toMatchObject({ status: 403 });
    expect(seen).toEqual([]);
  });

  it("review-trust, project-restricted and local-mcp principals cannot change account state or the gateway", async () => {
    await configure();
    const refused: Principal[] = [
      client(["settings:read", "settings:write"], "review"),
      client(["settings:read", "settings:write"], "trusted", ["demo"]),
      { ...LOCAL_MCP_PRINCIPAL, scopes: new Set<Scope>(["settings:read", "settings:write"]) },
    ];
    for (const p of refused) {
      for (const [name, input] of [
        ["accounts.pause", { accountId: "a1" }],
        ["accounts.resume", { accountId: "a1" }],
        ["accounts.priority", { accountId: "a1", priority: 1 }],
        ["accounts.thresholds", { accountId: "a1", thresholds: {} }],
        ["settings.update", { owlish: { url: "http://127.0.0.1:9" } }],
        ["settings.update", { owlishApiKey: "btr-hijack-key-0001" }],
      ] as const) {
        await expect(run(name, p, input), `${p.id} ${name}`).rejects.toMatchObject({
          status: 403,
          code: "forbidden_trust",
        });
      }
    }
    expect(await service.owlishSecrets.get()).toBe(KEY);
    expect(seen).toEqual([]);
  });

  it("local-mcp as it really is (no settings:write at all) is refused on every mutation", async () => {
    await configure();
    await expect(
      run("accounts.pause", LOCAL_MCP_PRINCIPAL, { accountId: "a1" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      run("settings.update", LOCAL_MCP_PRINCIPAL, { owlishApiKey: "btr-x-key-000000001" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(seen).toEqual([]);
  });
});

describe("secrets stay out of the audit extras and logs", () => {
  it("the ops pass no argument values to the audit hook", async () => {
    await configure();
    const extras: Record<string, unknown>[] = [];
    const ctx = {
      ...ctxFor(LOCAL_PRINCIPAL),
      audit: (e: Record<string, unknown>) => extras.push(e),
    };
    await getOp("settings.update")!.execute(ctx, { owlishApiKey: "btr-another-key-0001" });
    await getOp("accounts.priority")!.execute(ctx, { accountId: "a1", priority: 3 });
    expect(JSON.stringify(extras)).not.toContain("btr-");
    expect(await readdir(root)).not.toContain("audit"); // direct execute writes no line; the REST layer does
  });
});
