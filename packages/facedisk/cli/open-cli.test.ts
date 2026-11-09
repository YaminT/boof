import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserSessionStore, SettingsStore, dataRootPaths, defaultSettings } from "@boof/heart";
import { openCommand } from "./open-cli.js";

let root: string;
let out: string[];
let errs: string[];
const savedPort = process.env.BOOF_RUNNER_PORT;

const run = (...argv: string[]) =>
  openCommand(
    argv,
    () => root,
    (l) => out.push(l),
    (l) => errs.push(l),
    async () => true,
  );
const runProbe = (up: boolean, ...argv: string[]) =>
  openCommand(
    argv,
    () => root,
    (l) => out.push(l),
    (l) => errs.push(l),
    async () => up,
  );

const codeOf = (lines: string[]): string => {
  const m = /\/auth\/browser\?code=(bl_[A-Za-z0-9_-]+)/.exec(lines.join("\n"));
  expect(m).not.toBeNull();
  return m![1]!;
};

async function auditText(): Promise<string> {
  const dir = dataRootPaths(root).audit;
  const files = await readdir(dir).catch(() => [] as string[]);
  return (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))).join("");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-opencli-"));
  out = [];
  errs = [];
  delete process.env.BOOF_RUNNER_PORT;
});
afterEach(async () => {
  if (savedPort === undefined) delete process.env.BOOF_RUNNER_PORT;
  else process.env.BOOF_RUNNER_PORT = savedPort;
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("boof-runner open", () => {
  it("prints a link whose code the server's store redeems", async () => {
    expect(await run("-d", root)).toBe(0);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("Sign in to the boof web UI (single use, valid for 10 minutes):");
    expect(out[1]).toMatch(/^ {2}http:\/\/127\.0\.0\.1:4319\/auth\/browser\?code=bl_/);
    const code = codeOf(out);
    // A different store instance, as the running server would have.
    const redeemed = await new BrowserSessionStore(root).redeemLink(code);
    expect(redeemed?.token).toMatch(/^bs_/);
    expect(await new BrowserSessionStore(root).redeemLink(code)).toBeNull();
    expect(errs).toEqual([]);
  });

  it("binds the link to the port it prints", async () => {
    expect(await run("-d", root, "--port", "6002")).toBe(0);
    const code = codeOf(out);
    expect(await new BrowserSessionStore(root).redeemLink(code, { port: 4319 })).toBeNull();
    // The mismatched attempt burned it.
    expect(await new BrowserSessionStore(root).redeemLink(code, { port: 6002 })).toBeNull();
    out.length = 0;
    await run("-d", root, "--port", "6002");
    expect(
      await new BrowserSessionStore(root).redeemLink(codeOf(out), { port: 6002 }),
    ).not.toBeNull();
  });

  it("without --port warns when nothing answers on the default port", async () => {
    expect(await runProbe(false, "-d", root)).toBe(0);
    expect(errs.join("\n")).toMatch(/nothing answers on 127\.0\.0\.1:4319/);
    expect(out[1]).toContain(":4319/");
  });

  it("does not warn when the default port answers, or when --port is given", async () => {
    await runProbe(true, "-d", root);
    expect(errs).toEqual([]);
    await runProbe(false, "-d", root, "--port", "6002");
    expect(errs).toEqual([]);
  });

  it("--port and BOOF_RUNNER_PORT pick the port; default 4319", async () => {
    await run("-d", root);
    expect(out[1]).toContain(":4319/");
    out.length = 0;
    process.env.BOOF_RUNNER_PORT = "5001";
    await run("-d", root);
    expect(out[1]).toContain(":5001/");
    out.length = 0;
    await run("-d", root, "--port", "6002", "--host", "localhost");
    expect(out[1]).toMatch(/^ {2}http:\/\/localhost:6002\/auth\/browser\?code=bl_/);
  });

  it("--host ::1 prints a bracketed address", async () => {
    expect(await run("-d", root, "--port", "6003", "--host", "::1")).toBe(0);
    expect(out[1]).toMatch(/^ {2}http:\/\/\[::1\]:6003\/auth\/browser\?code=bl_/);
  });

  it("refuses a data root that does not exist and creates nothing", async () => {
    const missing = join(root, "nope");
    expect(await run("-d", missing)).toBe(1);
    expect(errs.join("\n")).toContain(`open: no boof data root at ${missing}; pass -d <data root>`);
    expect(out).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects a bad port or a non-loopback host", async () => {
    expect(await run("-d", root, "--port", "abc")).toBe(1);
    expect(await run("-d", root, "--host", "example.com")).toBe(1);
    expect(out).toEqual([]);
  });

  it("required mode: exit 1, the message above, no link stored", async () => {
    await mkdir(root, { recursive: true });
    const base = defaultSettings();
    await new SettingsStore(root).save({
      ...base,
      security: { ...base.security, auth: { mode: "required" } },
    });
    expect(await run("-d", root)).toBe(1);
    expect(out).toEqual([]);
    expect(errs.join("\n")).toContain(
      'security.auth.mode is "required": the web UI uses an API key (paste one created with "boof-runner auth add").',
    );
    await expect(readFile(dataRootPaths(root).browserLinks, "utf8")).rejects.toThrow();
  });

  it("--revoke-all signs out every session and reports the count", async () => {
    const store = new BrowserSessionStore(root);
    await store.createSession();
    await store.createSession();
    expect(await run("-d", root, "--revoke-all")).toBe(0);
    expect(out).toEqual(["Signed out 2 browser session(s)."]);
    expect(await store.revokeAll()).toBe(0);
  });

  it("writes cli:open and cli:open.revoke-all audit lines without the code", async () => {
    await run("-d", root);
    const code = codeOf(out);
    await run("-d", root, "--revoke-all");
    const text = await auditText();
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.action)).toEqual(["cli:open", "cli:open.revoke-all"]);
    expect(lines.map((l) => l.principal)).toEqual(["local", "local"]);
    expect(text).not.toContain(code);
    expect(text).not.toContain("bl_");
  });
});
