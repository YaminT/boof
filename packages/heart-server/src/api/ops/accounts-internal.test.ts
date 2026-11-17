import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, SettingsStore, type Principal, type Scope } from "@boof/heart";
import { stopSharedInternalBackend } from "@boof/owlish";
import { MockTool, ToolRegistry } from "@boof/runner";
import type { OpContext } from "../define-op.js";
import { OpError } from "../errors.js";
import { getOp } from "../registry.js";
import { TaskService } from "../services/service.js";

const KEY = "sk-ant-api03-OPSKEYOPSKEYOPSKEY00";
let root: string;
let service: TaskService;

const client = (scopes: Scope[], trust: "trusted" | "review" = "trusted"): Principal => ({
  kind: "client",
  id: "c1",
  name: "c1",
  scopes: new Set(scopes),
  projects: "*",
  trust,
});
const admin = client(["settings:read", "settings:write"]);
const run = (name: string, principal: Principal, input: object = {}) =>
  getOp(name)!.execute(
    {
      root,
      principal,
      services: service,
      authStore: new AuthStore(root),
      now: () => "2026-01-01T00:00:00.000Z",
    } as OpContext,
    input,
  ) as Promise<Record<string, any>>;
const setMode = (mode: "internal" | "better-ccflare" | "none") =>
  new SettingsStore(root).update({ gateway: { mode } });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-accounts-internal-"));
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
});
afterEach(async () => {
  await stopSharedInternalBackend(root);
  await rm(root, { recursive: true, force: true });
});

describe("internal pool operations", () => {
  it("add, list, pause, priority, remove; the key is never returned", async () => {
    await setMode("internal");
    const added = await run("accounts.add", admin, { name: "work", apiKey: KEY, priority: 3 });
    expect(JSON.stringify(added)).not.toContain(KEY);
    expect(added.account).toMatchObject({
      name: "work",
      priority: 3,
      provider: "claude-console-api",
    });
    const id = added.account.id as string;

    const list = await run("accounts.list", admin);
    expect(list.configured).toBe(true);
    expect(JSON.stringify(list)).not.toContain(KEY);
    expect(list.accounts).toHaveLength(1);

    await run("accounts.pause", admin, { accountId: id });
    expect((await run("accounts.list", admin)).accounts[0].paused).toBe(true);
    expect((await run("accounts.health", admin)).pool.status).toBe("unhealthy");
    await run("accounts.resume", admin, { accountId: id });
    await run("accounts.priority", admin, { accountId: id, priority: 9 });
    expect((await run("accounts.list", admin)).accounts[0].priority).toBe(9);

    const health = await run("accounts.health", admin);
    expect(health).toMatchObject({ configured: true, url: null, keySource: null });
    expect(JSON.stringify(health)).not.toContain(KEY);
    expect((await run("accounts.agentSdk", admin)).allowed).toBe(true);

    await run("accounts.remove", admin, { accountId: id });
    expect((await run("accounts.list", admin)).accounts).toEqual([]);
    expect(await readFile(join(root, "gateway", "accounts.json"), "utf8")).not.toContain(KEY);
  });

  it("keeps the key file private and the key out of settings", async () => {
    await setMode("internal");
    await run("accounts.add", admin, { name: "work", apiKey: KEY });
    if (process.platform !== "win32") {
      expect((await stat(join(root, "gateway", "accounts.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "gateway"))).mode & 0o777).toBe(0o700);
    }
    expect(JSON.stringify(await run("settings.get", admin))).not.toContain(KEY);
  });

  it("rejects a bad key or a subscription token with 400 and no echo", async () => {
    await setMode("internal");
    for (const bad of ["sk-ant-oat01-" + "x".repeat(30), "not-a-key-but-long-enough-xx"]) {
      const err = await run("accounts.add", admin, { name: "n", apiKey: bad }).catch((e) => e);
      expect(err).toBeInstanceOf(OpError);
      expect(err.status).toBe(400);
      expect(String(err.message)).not.toContain(bad);
    }
    expect((await run("accounts.list", admin)).accounts).toEqual([]);
  });

  it("answers 404 for an unknown account and 409 for thresholds", async () => {
    await setMode("internal");
    const missing = await run("accounts.remove", admin, { accountId: "acc-nope" }).catch((e) => e);
    expect(missing.status).toBe(404);
    const thr = await run("accounts.thresholds", admin, {
      accountId: "acc-nope",
      thresholds: { fiveHour: 80 },
    }).catch((e) => e);
    expect(thr.status).toBe(409);
    expect(thr.code).toBe("not_supported");
  });

  it("answers 409 for add and remove unless the mode is internal", async () => {
    for (const mode of ["better-ccflare", "none"] as const) {
      await setMode(mode);
      for (const [op, input] of [
        ["accounts.add", { name: "n", apiKey: KEY }],
        ["accounts.remove", { accountId: "acc-x" }],
      ] as const) {
        const err = await run(op, admin, input).catch((e) => e);
        expect(err.status, `${op} ${mode}`).toBe(409);
        expect(err.code).toBe("not_supported");
      }
    }
  });

  it("needs settings:write and a trusted client", async () => {
    await setMode("internal");
    const reader = client(["settings:read"]);
    await expect(run("accounts.add", reader, { name: "n", apiKey: KEY })).rejects.toBeTruthy();
    const review = client(["settings:read", "settings:write"], "review");
    await expect(run("accounts.add", review, { name: "n", apiKey: KEY })).rejects.toBeTruthy();
    expect((await run("accounts.list", admin)).accounts).toEqual([]);
  });

  it("absent settings: list says not configured and writes nothing", async () => {
    expect(await run("accounts.list", admin)).toEqual({ configured: false, accounts: [] });
    expect((await run("accounts.health", admin)).configured).toBe(false);
  });

  describe("accounts.import", () => {
    const makeDb = (path: string) => {
      const d = new DatabaseSync(path);
      d.exec(
        "CREATE TABLE accounts (id TEXT, name TEXT, provider TEXT, api_key TEXT, priority INT)",
      );
      const ins = d.prepare("INSERT INTO accounts VALUES (?, ?, ?, ?, ?)");
      ins.run("1", "sub", "anthropic", null, 0);
      ins.run("2", "console", "claude-console-api", KEY, 1);
      d.close();
    };

    it("imports API-key accounts, skips subscriptions, never returns a key", async () => {
      await setMode("internal");
      const path = join(root, "ccflare.db");
      makeDb(path);
      const out = await run("accounts.import", admin, { source: "better-ccflare", path });
      expect(out.imported).toEqual([{ name: "console" }]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0]).toMatchObject({ name: "sub", provider: "anthropic" });
      expect(JSON.stringify(out)).not.toContain(KEY);
      expect((await run("accounts.list", admin)).accounts).toHaveLength(1);
      // The same key a second time is skipped, not duplicated.
      const again = await run("accounts.import", admin, { source: "better-ccflare", path });
      expect(again.imported).toEqual([]);
      expect(again.skipped.map((s: any) => s.reason)).toContain("that key is already in the pool");
    });

    it("answers 400 for an unreadable database, 409 outside internal mode, 403 without trust", async () => {
      await setMode("internal");
      await expect(
        run("accounts.import", admin, { source: "better-ccflare", path: join(root, "none.db") }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        run("accounts.import", client(["settings:write"], "review"), { source: "better-ccflare" }),
      ).rejects.toBeInstanceOf(OpError);
      await setMode("better-ccflare");
      await expect(
        run("accounts.import", admin, { source: "better-ccflare" }),
      ).rejects.toMatchObject({ status: 409, code: "not_supported" });
    });
  });
});
