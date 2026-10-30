import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isServeFlag, main } from "./boof-runner.js";

describe("boof-runner top level", () => {
  let logs: string[];
  let errs: string[];
  let dataRoot: string;

  beforeEach(async () => {
    logs = [];
    errs = [];
    vi.spyOn(console, "log").mockImplementation((l) => void logs.push(String(l)));
    vi.spyOn(console, "error").mockImplementation((l) => void errs.push(String(l)));
    dataRoot = await mkdtemp(join(tmpdir(), "boof-cli-top-"));
    process.env.BOOF_RUNNER_DATA_ROOT = dataRoot; // never ./data, whatever happens
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    delete process.env.BOOF_RUNNER_DATA_ROOT;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("only serve's own flags fall through to serve", () => {
    for (const t of [
      "-d",
      "--data",
      "--data=/x",
      "-p",
      "--port=1",
      "--host",
      "--no-runner",
      "--tls-cert",
      "--tls-key",
    ]) {
      expect(isServeFlag(t), t).toBe(true);
    }
    for (const t of ["status", "sevre", "--version", "-v", "--verbose", "--datum", "serve", ""]) {
      expect(isServeFlag(t), t).toBe(false);
    }
  });

  it("--version and -v print the root package.json version and exit 0", async () => {
    const { version } = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    await main(["--version"]);
    await main(["-v"]);
    expect(logs).toEqual([version, version]);
    expect(errs).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(await readdir(dataRoot)).toEqual([]); // nothing scaffolded
  });

  it("--version works after serve's own flags and starts nothing", async () => {
    await main(["-d", dataRoot, "--version"]);
    await main(["serve", "-v"]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/^\d+\.\d+\.\d+/);
    expect(await readdir(dataRoot)).toEqual([]);
  });

  it("an unknown command with --help is still unknown", async () => {
    await main(["typo", "--help"]);
    expect(process.exitCode).toBe(1);
    expect(errs).toEqual(['boof-runner: unknown command "typo" (see "boof-runner --help")']);
    expect(logs).toEqual([]);
  });

  it("an unknown command prints one error line, exits 1, scaffolds nothing", async () => {
    await main(["status"]);
    expect(process.exitCode).toBe(1);
    expect(errs).toEqual(['boof-runner: unknown command "status" (see "boof-runner --help")']);
    expect(logs).toEqual([]);
    expect(await readdir(dataRoot)).toEqual([]);
    expect(existsSync(join(process.cwd(), "data", "settings.json"))).toBe(false);
  });
});
