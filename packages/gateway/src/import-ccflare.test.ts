import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CcflareImportError,
  defaultCcflareDb,
  importCcflare,
  scanCcflare,
} from "./import-ccflare.js";

const K1 = "sk-ant-api03-IMPORTKEYONEIMPORTKEY1";
const K2 = "sk-ant-api03-IMPORTKEYTWOIMPORTKEY2";
let dir: string;
let db: string;

const make = (rows: [string, string, string | null, number][]) => {
  const d = new DatabaseSync(db);
  d.exec(
    "CREATE TABLE accounts (id TEXT, name TEXT, provider TEXT, api_key TEXT, refresh_token TEXT, priority INT)",
  );
  const ins = d.prepare(
    "INSERT INTO accounts (id, name, provider, api_key, refresh_token, priority) VALUES (?, ?, ?, ?, 'rt-secret', ?)",
  );
  rows.forEach(([name, provider, key, priority], i) =>
    ins.run(`id${i}`, name, provider, key, priority),
  );
  d.close();
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gateway-import-"));
  db = join(dir, "better-ccflare.db");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("import from better-ccflare", () => {
  it("imports console API-key accounts and skips the rest with reasons", async () => {
    make([
      ["sub", "anthropic", null, 0],
      ["work", "claude-console-api", K1, 1],
      ["codex", "codex", null, 2],
      ["spare", "claude-console-api", K2, 3],
      ["broken", "claude-console-api", "not-a-key", 4],
      ["z", "openrouter", "sk-or-xxx", 5],
    ]);
    const added: { name: string; apiKey: string }[] = [];
    const r = await importCcflare(db, async (a) => void added.push(a));
    expect(added.map((a) => a.name)).toEqual(["work", "spare"]);
    expect(r.imported).toEqual([{ name: "work" }, { name: "spare" }]);
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.name, s.reason]));
    expect(reasons.sub).toMatch(/subscription \(OAuth\)/);
    expect(reasons.codex).toMatch(/Codex/);
    expect(reasons.broken).toMatch(/no valid Anthropic API key/);
    expect(reasons.z).toMatch(/not supported/);
    // The result carries no key and no refresh token.
    expect(JSON.stringify(r)).not.toMatch(/sk-ant|rt-secret/);
  });

  it("reports an account the pool rejects without throwing or leaking the key", async () => {
    make([["work", "claude-console-api", K1, 0]]);
    const r = await importCcflare(db, async () => {
      throw new Error("that key is already in the pool");
    });
    expect(r.imported).toEqual([]);
    expect(r.skipped).toEqual([
      { name: "work", provider: "claude-console-api", reason: "that key is already in the pool" },
    ]);
  });

  it("opens the database read-only: the file is unchanged and no side files appear", async () => {
    make([["work", "claude-console-api", K1, 0]]);
    const before = await readFile(db);
    const mtime = (await stat(db)).mtimeMs;
    await scanCcflare(db);
    expect(await readFile(db)).toEqual(before);
    expect((await stat(db)).mtimeMs).toBe(mtime);
    expect(readdirSync(dir)).toEqual(["better-ccflare.db"]);
  });

  it("fails clearly for a missing file and for a file that is not a better-ccflare database", async () => {
    await expect(scanCcflare(join(dir, "nope.db"))).rejects.toBeInstanceOf(CcflareImportError);
    const d = new DatabaseSync(db);
    d.exec("CREATE TABLE other (x)");
    d.close();
    await expect(scanCcflare(db)).rejects.toThrow(/not a better-ccflare database/);
  });

  it("looks in ~/.config/better-ccflare by default", () => {
    expect(defaultCcflareDb("/home/u")).toBe("/home/u/.config/better-ccflare/better-ccflare.db");
  });
});
