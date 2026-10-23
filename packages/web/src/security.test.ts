import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthStore,
  SecuritySettingsSchema,
  SettingsStore,
  type Scope,
  type SecuritySettings,
} from "@boof-runner/shared";
import { MockTool, ToolRegistry } from "@boof-runner/runner";
import { createApp } from "./app.js";
import { pruneAudit } from "./middleware/audit.js";
import { assertBindAllowed, startServer } from "./server.js";
import { TaskService } from "./service.js";

let root: string;
let service: TaskService;
let store: AuthStore;
let clock: number;
let peer: string | undefined;

const LOOPBACK = "127.0.0.1";
const REMOTE = "10.1.2.3";

async function setSecurity(patch: Partial<SecuritySettings>): Promise<void> {
  const settings = new SettingsStore(root);
  const current = await settings.load();
  await settings.save({
    ...current,
    security: SecuritySettingsSchema.parse({ ...current.security, ...patch }),
  });
}

function build(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({
    service,
    authStore: store,
    peerAddress: () => peer,
    now: () => clock,
    ...extra,
  });
}

const call = (
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
  key?: string,
) =>
  app.request("http://localhost" + path, {
    ...init,
    headers: {
      ...(init.headers as object),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
  });
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function mint(
  name: string,
  scopes: Scope[],
  extra: { trust?: "trusted" | "review"; projects?: string[] | "*" } = {},
) {
  return (await store.create({ name, scopes, ...extra })).key;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-sec-"));
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  await service.tasks.ensureDirs();
  await service.loadSettings();
  clock = Date.parse("2026-03-01T12:00:00Z");
  store = new AuthStore(root, () => clock);
  peer = LOOPBACK;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("authenticate", () => {
  it("local-trust: loopback peer without Authorization is the local principal", async () => {
    const res = await call(build(), "/api/tasks");
    expect(res.status).toBe(200);
  });

  it("401 for a non-loopback peer without a key", async () => {
    peer = REMOTE;
    const res = await call(build(), "/api/tasks");
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthenticated");
  });

  it("an unknown peer address is treated as non-loopback", async () => {
    peer = undefined;
    expect((await call(build(), "/api/tasks")).status).toBe(401);
  });

  it("a proxied request (X-Forwarded-For) never gets local trust", async () => {
    const res = await call(build(), "/api/tasks", { headers: { "x-forwarded-for": "8.8.8.8" } });
    expect(res.status).toBe(401);
  });

  it("a valid key works from a non-loopback peer; garbage keys do not", async () => {
    peer = REMOTE;
    const key = await mint("harness", ["tasks:read"]);
    const app = build();
    expect((await call(app, "/api/tasks", {}, key)).status).toBe(200);
    expect((await call(app, "/api/tasks", {}, key + "x")).status).toBe(401);
    expect((await call(app, "/api/tasks", {}, "boof_nope_zzzz")).status).toBe(401);
    const res = await app.request("http://localhost/api/tasks", {
      headers: { authorization: "Basic abc" },
    });
    expect(res.status).toBe(401);
  });

  it("an invalid key on a loopback peer is rejected, not downgraded to local", async () => {
    expect((await call(build(), "/api/tasks", {}, "boof_nope_zzzz")).status).toBe(401);
  });

  it("required mode rejects loopback without a key and accepts one with a key", async () => {
    await setSecurity({ auth: { mode: "required" } });
    const key = await mint("harness", ["tasks:read"]);
    const app = build();
    expect((await call(app, "/api/tasks")).status).toBe(401);
    expect((await call(app, "/api/tasks", {}, key)).status).toBe(200);
  });

  it("revoked and expired keys get 401 with a specific message", async () => {
    peer = REMOTE;
    const revoked = await mint("old", ["tasks:read"]);
    const expiring = (
      await store.create({
        name: "short",
        scopes: ["tasks:read"],
        expiresAt: new Date(clock + 60_000).toISOString(),
      })
    ).key;
    const app = build();
    expect((await call(app, "/api/tasks", {}, revoked)).status).toBe(200);
    await store.revoke("old");
    const r = await call(app, "/api/tasks", {}, revoked);
    expect(r.status).toBe(401);
    expect((await r.json()).error.message).toContain("revoked");

    expect((await call(app, "/api/tasks", {}, expiring)).status).toBe(200);
    clock += 61_000;
    const e = await call(app, "/api/tasks", {}, expiring);
    expect(e.status).toBe(401);
    expect((await e.json()).error.message).toContain("expired");
  });

  it("host guard runs before auth: a bad Host is 421, not 401", async () => {
    peer = REMOTE;
    const res = await call(build(), "/api/tasks", { headers: { host: "evil.example" } });
    expect(res.status).toBe(421);
  });

  it("security.allowedHosts extends the host guard", async () => {
    await setSecurity({ allowedHosts: ["boof.lan"] });
    const res = await call(build(), "/api/tasks", { headers: { host: "boof.lan:4319" } });
    expect(res.status).toBe(200);
  });

  it("lastUsedAt is updated at most once a minute", async () => {
    peer = REMOTE;
    const key = await mint("harness", ["tasks:read"]);
    const app = build();
    await call(app, "/api/tasks", {}, key);
    await new Promise((r) => setTimeout(r, 50));
    const first = (await store.get("harness"))!.lastUsedAt;
    expect(first).toBe(new Date(clock).toISOString());
    clock += 30_000;
    await call(app, "/api/tasks", {}, key);
    await new Promise((r) => setTimeout(r, 50));
    expect((await store.get("harness"))!.lastUsedAt).toBe(first);
    clock += 31_000;
    await call(app, "/api/tasks", {}, key);
    await new Promise((r) => setTimeout(r, 50));
    expect((await store.get("harness"))!.lastUsedAt).toBe(new Date(clock).toISOString());
  });

  it("the client cache notices an out-of-process change, checked at most every 5 s", async () => {
    peer = REMOTE;
    const key = await mint("harness", ["tasks:read"]);
    const app = build();
    expect((await call(app, "/api/tasks", {}, key)).status).toBe(200);
    // Let the lastUsedAt write land, then warm the cache again so it is current.
    await new Promise((r) => setTimeout(r, 50));
    expect((await call(app, "/api/tasks", {}, key)).status).toBe(200);
    // Another process (a different AuthStore instance) revokes it.
    const other = new AuthStore(root, () => clock);
    await other.revoke("harness");
    // Make sure the mtime differs even on coarse filesystems.
    const future = new Date(Date.now() + 5000);
    await utimes(store.filePath, future, future);
    expect((await call(app, "/api/tasks", {}, key)).status).toBe(200); // still cached
    clock += 5_001;
    expect((await call(app, "/api/tasks", {}, key)).status).toBe(401);
  });
});

describe("authorize (scopes)", () => {
  it("403 forbidden_scope when the key lacks the route's scope", async () => {
    peer = REMOTE;
    const key = await mint("reader", ["tasks:read"]);
    const app = build();
    const res = await call(app, "/api/tasks", post({ title: "x" }), key);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_scope");
    expect((await call(app, "/api/settings", {}, key)).status).toBe(403);
    expect((await call(app, "/api/tasks/x/stop", { method: "POST" }, key)).status).toBe(403);
  });

  it("tasks:control grants stop/inject only; admin grants everything", async () => {
    peer = REMOTE;
    const control = await mint("ctl", ["tasks:control"]);
    const admin = await mint("root", ["admin"]);
    const app = build();
    // 404 (task missing) proves the scope check passed.
    expect((await call(app, "/api/tasks/nope/stop", { method: "POST" }, control)).status).toBe(404);
    expect((await call(app, "/api/settings", {}, admin)).status).toBe(200);
  });

  it("maps health/models to settings:read and usage/events to tasks:read", async () => {
    peer = REMOTE;
    const reader = await mint("reader", ["tasks:read"]);
    const settings = await mint("cfg", ["settings:read"]);
    const app = build();
    expect((await call(app, "/api/usage", {}, reader)).status).toBe(200);
    expect((await call(app, "/api/health", {}, reader)).status).toBe(403);
    expect((await call(app, "/api/health", {}, settings)).status).toBe(200);
    expect((await call(app, "/api/events", {}, settings)).status).toBe(403);
    expect((await call(app, "/api/events", {}, reader)).status).toBe(200);
  });
});

describe("rate limit", () => {
  it("429 with Retry-After after the per-minute budget, per principal", async () => {
    await setSecurity({ rateLimit: { perMinute: 3, attachmentsPerMinute: 30 } });
    peer = REMOTE;
    const a = await mint("a", ["tasks:read"]);
    const b = await mint("b", ["tasks:read"]);
    const app = build();
    for (let i = 0; i < 3; i += 1) expect((await call(app, "/api/tasks", {}, a)).status).toBe(200);
    const limited = await call(app, "/api/tasks", {}, a);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await limited.json()).error.code).toBe("rate_limited");
    // Another principal has its own bucket.
    expect((await call(app, "/api/tasks", {}, b)).status).toBe(200);
    // The bucket refills over time.
    clock += 60_000;
    expect((await call(app, "/api/tasks", {}, a)).status).toBe(200);
  });

  it("attachments use a separate bucket; the SSE route is excluded", async () => {
    await setSecurity({ rateLimit: { perMinute: 2, attachmentsPerMinute: 1 } });
    peer = REMOTE;
    const key = await mint("a", ["tasks:read", "tasks:write"]);
    const app = build();
    const upload = () => {
      const form = new FormData();
      form.append("file", new File(["x"], "a.png", { type: "image/png" }));
      return call(app, "/api/tasks/missing/attachments", { method: "POST", body: form }, key);
    };
    expect((await upload()).status).toBe(404); // reached the handler, used the attachment bucket
    expect((await upload()).status).toBe(429);
    // Regular bucket untouched by the uploads: two reads still pass.
    expect((await call(app, "/api/tasks", {}, key)).status).toBe(200);
    expect((await call(app, "/api/tasks", {}, key)).status).toBe(200);
    expect((await call(app, "/api/tasks", {}, key)).status).toBe(429);
    for (let i = 0; i < 5; i += 1) {
      expect((await call(app, "/api/events", {}, key)).status).toBe(200);
    }
  });
});

describe("audit log", () => {
  const readAudit = async () => {
    const dir = join(root, "audit");
    const files = await readdir(dir);
    expect(files).toEqual(["2026-03-01.jsonl"]);
    const raw = await readFile(join(dir, files[0]), "utf8");
    return {
      raw,
      lines: raw
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
    };
  };

  it("records who/what/outcome, hashes the prompt, and never logs prompts or keys", async () => {
    peer = REMOTE;
    const key = await mint("harness", ["tasks:read", "tasks:write"], { trust: "trusted" });
    const app = build();
    const prompt = "TOP-SECRET-PROMPT-TEXT";
    const created = await call(app, "/api/tasks", post({ title: "Audited", prompt }), key);
    expect(created.status).toBe(200);
    await call(app, "/api/tasks/audited", {}, key);
    await call(app, "/api/tasks", {}); // no key: 401, still logged
    const { raw, lines } = await readAudit();

    expect(raw).not.toContain(prompt);
    expect(raw).not.toContain(key);
    expect(raw).not.toContain(key.split("_").pop()!);

    const [create, get, denied] = lines;
    expect(create).toMatchObject({
      principal: "harness",
      kind: "client",
      action: "POST /api/tasks",
      status: 200,
      ip: REMOTE,
      promptLength: prompt.length,
    });
    expect(create.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof create.ms).toBe("number");
    expect(create.ts).toBe("2026-03-01T12:00:00.000Z");
    expect(get).toMatchObject({ action: "GET /api/tasks/:id", target: "audited", status: 200 });
    expect(denied).toMatchObject({ principal: "anonymous", status: 401 });
  });

  it("can be disabled", async () => {
    await setSecurity({ audit: { enabled: false, retentionDays: 90 } });
    await call(build(), "/api/tasks");
    await expect(readdir(join(root, "audit"))).rejects.toThrow();
  });

  it("prunes daily files older than retentionDays and keeps recent ones", async () => {
    const dir = join(root, "audit");
    await mkdir(dir, { recursive: true });
    for (const d of ["2025-01-01", "2026-02-27", "2026-03-01"]) {
      await writeFile(join(dir, `${d}.jsonl`), "{}\n");
    }
    await writeFile(join(dir, "notes.txt"), "keep");
    const removed = await pruneAudit(root, 7, clock);
    expect(removed.sort()).toEqual(["2025-01-01.jsonl"]);
    expect((await readdir(dir)).sort()).toEqual([
      "2026-02-27.jsonl",
      "2026-03-01.jsonl",
      "notes.txt",
    ]);
  });
});

describe("trust levels", () => {
  it("a review client's task is forced to draft, labelled, and carries its origin", async () => {
    peer = REMOTE;
    const key = await mint("Remote Bot", ["tasks:read", "tasks:write"]);
    const app = build();
    const res = await call(app, "/api/tasks", post({ title: "Do it", status: "pending" }), key);
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task.frontmatter.status).toBe("draft");
    expect(task.frontmatter.labels).toContain("external:remote-bot");
    expect(task.frontmatter.origin).toEqual({ kind: "api", client: "remote-bot" });
  });

  it("a review client cannot queue: update, retry, unarchive and answers give 403 forbidden_trust", async () => {
    peer = REMOTE;
    const key = await mint("Remote Bot", ["tasks:read", "tasks:write"]);
    const app = build();
    await call(app, "/api/tasks", post({ title: "Do it" }), key);
    const attempts: [string, RequestInit][] = [
      ["/api/tasks/do-it", { ...post({ status: "pending" }), method: "PUT" }],
      ["/api/tasks/do-it/retry", { method: "POST" }],
      ["/api/tasks/do-it/unarchive", { method: "POST" }],
      ["/api/tasks/do-it/answers", post({ answers: "yes" })],
    ];
    for (const [path, init] of attempts) {
      const res = await call(app, path, init, key);
      expect(res.status, path).toBe(403);
      expect((await res.json()).error.code).toBe("forbidden_trust");
    }
    // Still a draft; non-queue edits are fine.
    const edit = await call(
      app,
      "/api/tasks/do-it",
      { ...post({ title: "Renamed" }), method: "PUT" },
      key,
    );
    expect(edit.status).toBe(200);
    expect((await service.get("do-it"))!.frontmatter.status).toBe("draft");
  });

  it("a trusted client may create pending tasks and queue drafts", async () => {
    peer = REMOTE;
    const key = await mint("Good Bot", ["tasks:read", "tasks:write"], { trust: "trusted" });
    const app = build();
    const res = await call(app, "/api/tasks", post({ title: "Go", status: "pending" }), key);
    const task = await res.json();
    expect(task.frontmatter.status).toBe("pending");
    expect(task.frontmatter.labels).not.toContain("external:good-bot");
    expect(task.frontmatter.origin).toEqual({ kind: "api", client: "good-bot" });
    await call(app, "/api/tasks", post({ title: "Later" }), key);
    const queued = await call(
      app,
      "/api/tasks/later",
      { ...post({ status: "pending" }), method: "PUT" },
      key,
    );
    expect(queued.status).toBe(200);
  });

  it("externalTasksRequireApproval=false makes review clients behave like trusted for tasks", async () => {
    await setSecurity({ externalTasksRequireApproval: false });
    peer = REMOTE;
    const key = await mint("Remote Bot", ["tasks:read", "tasks:write"]);
    const res = await call(build(), "/api/tasks", post({ title: "Go", status: "pending" }), key);
    const task = await res.json();
    expect(task.frontmatter.status).toBe("pending");
    expect(task.frontmatter.labels).toEqual([]);
  });

  it("the local principal and the UI are unaffected and get no origin", async () => {
    const res = await call(build(), "/api/tasks", post({ title: "Mine", status: "pending" }));
    const task = await res.json();
    expect(task.frontmatter.status).toBe("pending");
    expect(task.frontmatter.origin).toBeUndefined();
  });
});

describe("auth admin API", () => {
  it("lists clients without key hashes and creates, rotates and revokes them", async () => {
    const app = build(); // local principal has admin
    const created = await call(
      app,
      "/api/auth/clients",
      post({ name: "Dash", scopes: ["tasks:read"], trust: "review", expiresIn: "7d" }),
    );
    expect(created.status).toBe(200);
    const { client, key } = await created.json();
    expect(client.id).toBe("dash");
    expect(key).toMatch(/^boof_dash_/);
    expect(client.keyHash).toBeUndefined();
    expect(Date.parse(client.expiresAt) - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000);

    const list = await (await call(app, "/api/auth/clients")).json();
    expect(JSON.stringify(list)).not.toContain("keyHash");
    expect(JSON.stringify(list)).not.toContain(key.split("_").pop()!);
    expect(list.clients).toHaveLength(1);

    const rotated = await (
      await call(app, "/api/auth/clients/dash/rotate", { method: "POST" })
    ).json();
    expect(rotated.key).not.toBe(key);
    expect(rotated.client.keyHash).toBeUndefined();
    peer = REMOTE;
    expect((await call(app, "/api/tasks", {}, key)).status).toBe(401);
    expect((await call(app, "/api/tasks", {}, rotated.key)).status).toBe(200);

    peer = LOOPBACK;
    const revoked = await call(app, "/api/auth/clients/dash/revoke", { method: "POST" });
    expect((await revoked.json()).client.revokedAt).toBeTruthy();
    peer = REMOTE;
    expect((await call(app, "/api/tasks", {}, rotated.key)).status).toBe(401);
  });

  it("requires auth:admin and never lets a client grant what it does not hold", async () => {
    peer = REMOTE;
    const plain = await mint("plain", ["tasks:read"]);
    const mgr = await mint("mgr", ["auth:admin", "tasks:read"]);
    const app = build();
    expect((await call(app, "/api/auth/clients", {}, plain)).status).toBe(403);
    const esc = await call(app, "/api/auth/clients", post({ name: "x", scopes: ["admin"] }), mgr);
    expect(esc.status).toBe(403);
    expect((await esc.json()).error.code).toBe("forbidden_scope");
    const trustEsc = await call(
      app,
      "/api/auth/clients",
      post({ name: "x", scopes: ["tasks:read"], trust: "trusted" }),
      mgr,
    );
    expect(trustEsc.status).toBe(403);
    const ok = await call(
      app,
      "/api/auth/clients",
      post({ name: "x", scopes: ["tasks:read"] }),
      mgr,
    );
    expect(ok.status).toBe(200);
    expect(
      (await call(app, "/api/auth/clients/nope!/revoke", { method: "POST" }, mgr)).status,
    ).toBe(400);
  });
});

describe("server binding", () => {
  it("assertBindAllowed: loopback always ok; others need required mode and an active client", async () => {
    const settings = await service.loadSettings();
    await expect(assertBindAllowed("127.0.0.1", settings, store)).resolves.toBeUndefined();
    await expect(assertBindAllowed("localhost", settings, store)).resolves.toBeUndefined();
    await expect(assertBindAllowed("::1", settings, store)).resolves.toBeUndefined();
    await expect(assertBindAllowed("0.0.0.0", settings, store)).rejects.toThrow(
      'refusing to bind 0.0.0.0: set security.auth.mode = "required" and create a client with "boof-runner auth add"',
    );

    await setSecurity({ auth: { mode: "required" } });
    const required = await service.loadSettings();
    await expect(assertBindAllowed("0.0.0.0", required, store)).rejects.toThrow(
      /no active API client/,
    );
    await mint("a", ["tasks:read"]);
    await expect(assertBindAllowed("0.0.0.0", required, store)).resolves.toBeUndefined();
    await store.revoke("a");
    await expect(assertBindAllowed("0.0.0.0", required, store)).rejects.toThrow(
      /no active API client/,
    );
  });

  it("startServer refuses a non-loopback bind without required mode", async () => {
    await expect(startServer({ root, port: 0, host: "0.0.0.0", warn: () => {} })).rejects.toThrow(
      /refusing to bind 0\.0\.0\.0/,
    );
  });

  it("serves a required-mode server on a wildcard bind: 401 without key, 200 with key, warns about TLS", async () => {
    await setSecurity({ auth: { mode: "required" } });
    const key = await mint("a", ["tasks:read"]);
    const warnings: string[] = [];
    const running = await startServer({
      root,
      port: 0,
      host: "0.0.0.0",
      warn: (m) => warnings.push(m),
    });
    try {
      const base = `http://127.0.0.1:${running.port}`;
      expect((await fetch(`${base}/api/tasks`)).status).toBe(401);
      const ok = await fetch(`${base}/api/tasks`, { headers: { authorization: `Bearer ${key}` } });
      expect(ok.status).toBe(200);
      expect(warnings.some((w) => w.includes("without TLS"))).toBe(true);
    } finally {
      await running.stop();
    }
  });

  it("local-trust over a real socket: loopback peer without a key is allowed", async () => {
    const running = await startServer({ root, port: 0, warn: () => {} });
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/api/tasks`);
      expect(res.status).toBe(200);
    } finally {
      await running.stop();
    }
  });

  it("serves HTTPS with --tls-cert/--tls-key", async (ctx) => {
    const dir = await mkdtemp(join(tmpdir(), "boof-runner-tls-"));
    try {
      try {
        execFileSync(
          "openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            join(dir, "k.pem"),
            "-out",
            join(dir, "c.pem"),
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
          ],
          { stdio: "ignore" },
        );
      } catch {
        return ctx.skip();
      }
      const running = await startServer({
        root,
        port: 0,
        tlsCert: join(dir, "c.pem"),
        tlsKey: join(dir, "k.pem"),
        warn: () => {},
      });
      try {
        const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        try {
          const res = await fetch(`https://127.0.0.1:${running.port}/api/tasks`);
          expect(res.status).toBe(200);
        } finally {
          if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
          else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
        }
      } finally {
        await running.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
