import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthStore,
  authorize,
  authorizeProject,
  formatKey,
  LOCAL_PRINCIPAL,
  parseDuration,
  parseKey,
  sha256Hex,
  type Principal,
} from "./index.js";

let root: string;
let clock: number;
let store: AuthStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-auth-"));
  clock = Date.parse("2026-01-01T00:00:00Z");
  store = new AuthStore(root, () => clock);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("key format", () => {
  it("is boof_<clientId>_<base64url(32 bytes)> and round-trips", async () => {
    const { client, key } = await store.create({ name: "CI Bot", scopes: ["tasks:read"] });
    expect(client.id).toBe("ci-bot");
    const m = /^boof_ci-bot_([A-Za-z0-9_-]{43})$/.exec(key);
    expect(m).not.toBeNull();
    expect(Buffer.from(m![1], "base64url")).toHaveLength(32);
    expect(parseKey(key)).toEqual({ clientId: "ci-bot", secret: m![1] });
    expect(parseKey(formatKey("a", "b_c"))).toEqual({ clientId: "a", secret: "b_c" });
  });

  it("rejects malformed keys", () => {
    for (const k of ["", "boof_", "boof__x", "boof_abc", "nope_abc_def", "boof_abc_"]) {
      expect(parseKey(k)).toBeNull();
    }
  });

  it("stores only the sha256 of the secret, never the secret", async () => {
    const { key } = await store.create({ name: "a", scopes: ["tasks:read"] });
    const secret = parseKey(key)!.secret;
    const raw = await readFile(store.filePath, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain(sha256Hex(secret));
  });
});

describe("verification", () => {
  it("accepts the right key and rejects a wrong secret or unknown client", async () => {
    const { key } = await store.create({ name: "a", scopes: ["tasks:read"] });
    expect((await store.verify(key)).ok).toBe(true);
    const bad = await store.verify(formatKey("a", "x".repeat(43)));
    expect(bad).toEqual({ ok: false, reason: "bad_secret" });
    const unknown = await store.verify(formatKey("zzz", "x".repeat(43)));
    expect(unknown).toEqual({ ok: false, reason: "unknown" });
    expect(await store.verify("garbage")).toEqual({ ok: false, reason: "malformed" });
  });

  it("revoked clients fail immediately", async () => {
    const { key } = await store.create({ name: "a", scopes: ["tasks:read"] });
    await store.revoke("a");
    expect(await store.verify(key)).toEqual({ ok: false, reason: "revoked" });
    expect(await store.hasActiveClient()).toBe(false);
  });

  it("expired clients fail once the clock passes expiresAt", async () => {
    const { key } = await store.create({
      name: "a",
      scopes: ["tasks:read"],
      expiresAt: new Date(clock + 1000).toISOString(),
    });
    expect((await store.verify(key)).ok).toBe(true);
    clock += 1000;
    expect(await store.verify(key)).toEqual({ ok: false, reason: "expired" });
    expect(await store.hasActiveClient()).toBe(false);
  });

  it("rotate invalidates the old secret at once and keeps the id", async () => {
    const first = await store.create({ name: "a", scopes: ["tasks:read"] });
    const second = await store.rotate("a");
    expect(second!.key).not.toBe(first.key);
    expect(await store.verify(first.key)).toEqual({ ok: false, reason: "bad_secret" });
    expect((await store.verify(second!.key)).ok).toBe(true);
    await store.revoke("a");
    expect(await store.rotate("a")).toBeNull();
    expect(await store.rotate("missing")).toBeNull();
  });

  it("uses timingSafeEqual on fixed-size digests (equal-length comparison path)", async () => {
    // A secret of any length hashes to 32 bytes, so a short or long guess never
    // short-circuits on length before the constant-time compare.
    const { key } = await store.create({ name: "a", scopes: ["tasks:read"] });
    for (const secret of ["a", "a".repeat(500)]) {
      expect(await store.verify(formatKey("a", secret))).toEqual({
        ok: false,
        reason: "bad_secret",
      });
    }
    expect((await store.verify(key)).ok).toBe(true);
  });
});

describe("storage", () => {
  it("writes auth/clients.json with mode 0600 and the directory 0700", async () => {
    await store.create({ name: "a", scopes: ["tasks:read"] });
    await store.touch("a");
    const file = join(root, "auth", "clients.json");
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "auth"))).mode & 0o777).toBe(0o700);
    }
  });

  it("assigns unique ids for repeated names and records lastUsedAt", async () => {
    const a = await store.create({ name: "bot", scopes: ["tasks:read"] });
    const b = await store.create({ name: "bot", scopes: ["tasks:read"] });
    expect([a.client.id, b.client.id]).toEqual(["bot", "bot-2"]);
    await store.touch("bot");
    expect((await store.get("bot"))!.lastUsedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("list is empty without a file and never needs the directory to exist", async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.mtimeMs()).toBe(0);
  });
});

describe("scopes and durations", () => {
  const principal = (scopes: Principal["scopes"], projects: Principal["projects"]): Principal => ({
    kind: "client",
    id: "c",
    name: "c",
    scopes,
    projects,
    trust: "review",
  });

  it("authorize honours scopes and admin implies all", () => {
    const p = principal(new Set(["tasks:read"]), "*");
    expect(authorize(p, "tasks:read")).toBe(true);
    expect(authorize(p, "tasks:write")).toBe(false);
    expect(authorize(principal(new Set(["admin"]), "*"), "settings:write")).toBe(true);
    expect(authorize(LOCAL_PRINCIPAL, "auth:admin")).toBe(true);
  });

  it("authorizeProject allows * and listed projects only", () => {
    expect(authorizeProject(principal(new Set(), "*"), "any")).toBe(true);
    const p = principal(new Set(), new Set(["alpha"]));
    expect(authorizeProject(p, "alpha")).toBe(true);
    expect(authorizeProject(p, "beta")).toBe(false);
  });

  it("parseDuration understands s/m/h/d/w and rejects junk", () => {
    expect(parseDuration("30d")).toBe(30 * 86_400_000);
    expect(parseDuration("12h")).toBe(12 * 3_600_000);
    expect(() => parseDuration("soon")).toThrow();
  });
});
