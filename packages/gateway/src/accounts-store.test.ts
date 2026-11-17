import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountsStore, isAnthropicApiKey, type AccountRecord } from "./accounts-store.js";
import { Pool } from "./pool.js";
import { redactSecrets } from "./redact.js";

const KEY = "sk-ant-api03-SECRETSECRETSECRET1234";
const posix = process.platform !== "win32";
let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gateway-store-"));
  dir = join(root, "gateway");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const record = (over: Partial<AccountRecord> = {}): AccountRecord => ({
  id: "acc-1",
  name: "work",
  provider: "claude-console-api",
  apiKey: KEY,
  priority: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("isAnthropicApiKey", () => {
  it("accepts console keys and rejects other shapes", () => {
    expect(isAnthropicApiKey(KEY)).toBe(true);
    expect(isAnthropicApiKey("sk-ant-oat01-abcdefghijkl")).toBe(false);
    expect(isAnthropicApiKey("sk-ant-api03-short")).toBe(false);
    expect(isAnthropicApiKey("sk-ant-api03-has space here")).toBe(false);
    expect(isAnthropicApiKey(42)).toBe(false);
  });
});

describe("AccountsStore", () => {
  it("round-trips accounts and state", async () => {
    const store = new AccountsStore(dir);
    expect(await store.loadAccounts()).toEqual([]);
    await store.saveAccounts([record()]);
    expect(await store.loadAccounts()).toEqual([record()]);
    expect((await store.loadState()).size).toBe(0);
  });

  it.skipIf(!posix)("writes accounts.json 0600 and the directory 0700", async () => {
    const store = new AccountsStore(dir);
    await store.saveAccounts([record()]);
    await store.saveState(new Map());
    expect((await stat(store.accountsPath)).mode & 0o777).toBe(0o600);
    expect((await stat(store.statePath)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(!posix)("tighten brings a loose restored copy to 0600/0700", async () => {
    const store = new AccountsStore(dir);
    await store.saveAccounts([record()]);
    const { chmod } = await import("node:fs/promises");
    await chmod(store.accountsPath, 0o644);
    await chmod(dir, 0o755);
    await store.tighten();
    expect((await stat(store.accountsPath)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("never quotes a damaged file in the error", async () => {
    await mkdir(dir, { recursive: true });
    const store = new AccountsStore(dir);
    await writeFile(store.accountsPath, `{"accounts": "${KEY}" nope`);
    await expect(store.loadAccounts()).rejects.toThrow(/not valid JSON/);
    await writeFile(
      store.accountsPath,
      JSON.stringify({ version: 1, accounts: [{ apiKey: KEY }] }),
    );
    const err = await store.loadAccounts().catch((e: Error) => e);
    expect((err as Error).message).toMatch(/unexpected shape/);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("drops a damaged state file instead of failing", async () => {
    await mkdir(dir, { recursive: true });
    const store = new AccountsStore(dir);
    await writeFile(store.statePath, "{ broken");
    expect((await store.loadState()).size).toBe(0);
  });
});

describe("secrets never leak", () => {
  it("keeps keys out of state.json, summaries, status, errors and the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const store = new AccountsStore(dir);
    const pool = await Pool.open({ store, now: () => 1000 });
    const added = await pool.add({ name: "work", apiKey: KEY });
    const bad = await pool.add({ name: "dup", apiKey: KEY }).catch((e: Error) => e.message);
    const bad2 = await pool
      .add({ name: "x", apiKey: "sk-ant-oat01-nope" })
      .catch((e: Error) => e.message);
    pool.pick();
    await pool.flush();

    const surfaces = [
      JSON.stringify(added),
      JSON.stringify(pool.accountList()),
      JSON.stringify(pool.status()),
      String(bad),
      String(bad2),
      await readFile(store.statePath, "utf8"),
    ];
    for (const s of surfaces) expect(s).not.toContain("SECRETSECRET");
    expect(await readFile(store.accountsPath, "utf8")).toContain(KEY);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("redactSecrets masks keys, run tokens and extra secrets", () => {
    const token = "bgw_" + "A".repeat(43);
    const out = redactSecrets(`k=${KEY} t=${token} s=hunter22hunter`, ["hunter22hunter"]);
    expect(out).not.toMatch(/SECRETSECRET|AAAAAAAA|hunter22/);
    expect(out).toContain("[redacted]");
  });
});
