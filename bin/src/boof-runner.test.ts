import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isServeFlag, main, routeArgv } from "./boof-runner.js";

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

  it("serve with stray words names the words, not the flag values", async () => {
    await main(["serve", "tasks", "list", "-d", "/x"]);
    expect(process.exitCode).toBe(1);
    expect(errs).toEqual(['boof-runner: unknown command: tasks list (see "boof-runner --help")']);
  });

  it("ops lists the generated commands, and an operation command runs", async () => {
    await main(["ops"]);
    expect(logs.join("\n")).toContain("tasks create");
    logs.length = 0;
    await main(["auth", "clients", "list", "--json"]);
    expect(JSON.parse(logs.join("\n"))).toHaveProperty("clients");
  });

  it("auth list still runs the hand-written command, and an area alone is not an unknown command", async () => {
    logs.length = 0;
    await main(["auth", "list"]);
    expect(logs.join("\n")).not.toMatch(/^\s*\{/);
    expect(process.exitCode ?? 0).toBe(0);
    logs.length = 0;
    errs.length = 0;
    await main(["tasks"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("tasks create");
    expect(errs.join("\n")).not.toContain("unknown command");
  });

  it("routes the global flags that stand before the command words", () => {
    expect(routeArgv(["-d", "x", "tasks", "list"])).toEqual(["tasks", "list", "-d", "x"]);
    expect(routeArgv(["--client", "c", "tasks", "list"])).toEqual([
      "tasks",
      "list",
      "--client",
      "c",
    ]);
    expect(routeArgv(["--data=x", "run", "p"])).toEqual(["run", "p", "--data=x"]);
    expect(routeArgv(["--json", "-d", "x", "ops"])).toEqual(["ops", "--json", "-d", "x"]);
    // No command word: the legacy flags-only form of serve, and the help and version flags.
    expect(routeArgv(["-d", "x"])).toEqual(["-d", "x"]);
    expect(routeArgv(["-p", "4000", "--no-runner"])).toEqual(["-p", "4000", "--no-runner"]);
    expect(routeArgv(["-d", "x", "--version"])).toEqual(["-d", "x", "--version"]);
    expect(routeArgv(["tasks", "list", "-d", "x"])).toEqual(["tasks", "list", "-d", "x"]);
    expect(routeArgv([])).toEqual([]);
  });

  it("an operation after -d runs and starts no server", async () => {
    await main(["-d", dataRoot, "projects", "list", "--json"]);
    expect(JSON.parse(logs.join("\n"))).toEqual({ projects: [] });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("--client before the command works, and a bad client is refused with exit 3", async () => {
    await main(["--client", "nobody", "projects", "list"]);
    expect(process.exitCode).toBe(3);
    expect(errs.join("\n")).toContain("unknown client: nobody");
    expect(errs.join("\n")).not.toContain("unknown command");
  });

  it("an unknown word after -d is an unknown command, and serve refuses stray words", async () => {
    await main(["-d", dataRoot, "bogus"]);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain('unknown command "bogus"');
    process.exitCode = undefined;
    errs.length = 0;
    await main(["serve", "tasks", "queue"]);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toMatch(/unknown command.*tasks/);
  });
});

describe("serve startup signals", () => {
  it("drains and releases the runner guard when SIGINT arrives during startup", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "boof-early-signal-"));
    const root = join(scratch, "data");
    const home = join(scratch, "home");
    await mkdir(home);
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("No free port assigned");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      probe.close((err) => (err ? reject(err) : resolve())),
    );
    try {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx/esm",
          "bin/src/boof-runner.ts",
          "serve",
          "--data",
          root,
          "--port",
          String(port),
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, HOME: home, BOOF_RUNNER_DATA_ROOT: root },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      let sentSignal = false;
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        if (!sentSignal && output.includes("Scaffolded data root:")) {
          sentSignal = true;
          child.kill("SIGINT");
        }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`serve did not exit; output:\n${output}`));
          }, 20_000);
          child.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          child.once("exit", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
          });
        },
      );
      expect(exit, output).toEqual({ code: 0, signal: null });
      expect(output).toContain("Shutting down (SIGINT)…");
      expect(existsSync(join(root, ".runner.pid"))).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
