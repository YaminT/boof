import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentEnv } from "../../packages/runner/src/agent-env.js";
import { agentMarkerFor } from "../../packages/runner/src/agent-marker.js";
import { dataRootsFromArgv } from "./boof-runner.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  process.exitCode = 0;
});
async function root() {
  const value = await mkdtemp(join(tmpdir(), "boof-containment-"));
  roots.push(value);
  return value;
}

describe("agent containment", () => {
  /** Start `serve -p 0 --no-runner` on a scratch root; run `fn` with its port; stop it. */
  async function withServer<T>(
    fn: (port: number, dataRoot: string, home: string) => T,
  ): Promise<T> {
    const dataRoot = await root();
    const home = await root();
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "bin/src/boof-runner.ts"),
        "serve",
        "-d",
        dataRoot,
        "-p",
        "0",
        "--no-runner",
      ],
      { env: { PATH: process.env.PATH, HOME: home } },
    );
    try {
      let text = "";
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`serve did not start:\n${text}`)), 45_000);
        child.stdout.on("data", (b: Buffer) => {
          text += b.toString();
          const m = /API:\s+http:\/\/[^:\s]+:(\d+)\/api/.exec(text);
          if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          }
        });
        child.on("exit", () => reject(new Error(`serve exited early:\n${text}`)));
      });
      child.removeAllListeners("exit");
      return await fn(port, dataRoot, home);
    } finally {
      child.kill("SIGTERM");
    }
  }

  /** What a task agent sees: the agent env, then plain HTTP on the server's own port. */
  const probe = (port: number, home: string, dataRoot: string) => {
    const script = `
      const base = "http://127.0.0.1:${port}";
      const get = async (path, init) => {
        const res = await fetch(base + path, { redirect: "manual", ...init });
        return { status: res.status, body: await res.text(), cookie: res.headers.get("set-cookie") };
      };
      (async () => {
        const out = {};
        out.projects = await get("/api/v1/projects");
        out.settings = await get("/api/v1/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
        out.clients = await get("/api/v1/auth/clients", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        out.mcp = await get("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
        out.signin = await get("/auth/browser");
        out.badcode = await get("/auth/browser?code=bl_guess");
        out.healthz = await get("/healthz");
        out.harness = await get("/harness.txt");
        console.log(JSON.stringify(out));
      })();`;
    const r = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: agentEnv({ PATH: process.env.PATH, HOME: home }, [], agentMarkerFor(dataRoot)),
    });
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout) as Record<
      string,
      { status: number; body: string; cookie: string | null }
    >;
  };

  it("a child with the agent env gets 401 on protected routes and no code for sign-in", async () => {
    await withServer(async (port, dataRoot, home) => {
      const seen = probe(port, home, dataRoot);
      for (const key of ["projects", "settings", "clients"]) expect(seen[key]!.status).toBe(401);
      expect(JSON.parse(seen.projects!.body).error.details.reason).toBe("browser_session_required");
      expect(seen.mcp!.status).toBe(401);
      expect(JSON.parse(seen.mcp!.body).error.details.reason).toBe("mcp_key_required");
      for (const key of ["signin", "badcode"]) {
        expect([400, 404]).toContain(seen[key]!.status);
        expect(seen[key]!.cookie).toBeNull();
      }
      expect(await readdir(join(dataRoot, "projects")).catch(() => [])).toEqual([]);
    });
  }, 90_000);

  it("the same child reads /healthz and /harness.txt (public by design)", async () => {
    await withServer(async (port, dataRoot, home) => {
      const seen = probe(port, home, dataRoot);
      expect(seen.healthz!.status).toBe(200);
      expect(seen.harness!.status).toBe(200);
      expect(seen.harness!.body).toContain("mcp_key_required");
    });
  }, 90_000);

  it.each([
    [["-p80e-0", "-dR"], "R"],
    [["-p80e-0", "-d", "R"], "R"],
    [["-n", "x", "-dR"], "R"],
    [["-xyd", "R"], "R"],
    [["-xydR"], "R"],
    [["-d=R"], "R"],
    [["--", "-dR"], "R"],
    [["-fd", "R"], "R"],
    [["-d", "R"], "R"],
    [["--data", "R"], "R"],
    [["--data=R"], "R"],
  ])("collects data root from argv %j", (args, expected) => {
    expect(dataRootsFromArgv(args)).toContain(expected);
  });

  const runCli = (
    args: string[],
    markerRoot: string,
    home: string,
    extraEnv: NodeJS.ProcessEnv = {},
  ) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", join(process.cwd(), "bin/src/boof-runner.ts"), ...args],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...agentEnv(
            {
              PATH: process.env.PATH,
              HOME: home,
              BOOF_RUNNER_AGENT_OF: agentMarkerFor(markerRoot),
            },
            [],
            agentMarkerFor(markerRoot),
          ),
          ...extraEnv,
        },
      },
    );

  const refusal =
    "boof-runner: refused. This process was started by a task agent of this boof data root, and task agents get no access to boof. Run boof-runner yourself, outside the agent.";

  it.each([
    [
      "checks repeated -d roots",
      (x: string, r: string) => [
        "auth",
        "clients",
        "create",
        "--name",
        "pwn",
        "--scopes",
        "admin",
        "-d",
        x,
        "-d",
        r,
      ],
    ],
    [
      "checks a -v value",
      (_x: string, r: string) => [
        "auth",
        "clients",
        "create",
        "--name",
        "-v",
        "--scopes",
        "admin",
        "-d",
        r,
      ],
    ],
    [
      "checks --data= roots",
      (_x: string, r: string) => [
        "auth",
        "clients",
        "create",
        "--name",
        "pwn",
        "--scopes",
        "admin",
        `--data=${r}`,
      ],
    ],
    [
      "checks attached short data values for remote setup",
      (_x: string, r: string) => [
        "remote",
        "setup",
        "--hostname",
        "x",
        "--scopes",
        "admin",
        `-d${r}`,
      ],
    ],
    [
      "checks data after an unknown grouped short option for remote setup",
      (_x: string, r: string) => [
        "remote",
        "setup",
        "--hostname",
        "x",
        "--scopes",
        "admin",
        "-p80e-0",
        `-d${r}`,
      ],
    ],
    [
      "checks attached short data values for project list",
      (_x: string, r: string) => ["project", "list", `-d${r}`],
    ],
  ])("refuses before creating anything when it %s", async (_label, args) => {
    const dataRoot = await root();
    const extraRoot = await root();
    const home = await root();
    const result = runCli(args(extraRoot, dataRoot), dataRoot, home);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(refusal);
    expect(await readdir(dataRoot)).toEqual([]);
  });

  describe("symlink and `..` spellings of the data root are refused (canonical form)", () => {
    const name = (r: string) => basename(r);
    const spellings: [string, (r: string, base: string) => Promise<string>][] = [
      ["plain", async (r) => r],
      [
        "<symlink to parent>/x/../x",
        async (r, base) => {
          const a = join(base, "a");
          await symlink(join(r, ".."), a);
          return join(a, name(r), "..", name(r));
        },
      ],
      [
        "<symlink to R>/missing/..",
        async (r, base) => {
          const l = join(base, "l");
          await symlink(r, l);
          return join(l, "missing", "..");
        },
      ],
      [
        "<symlink to R>/../<name> style via a linked parent",
        async (r, base) => {
          const l = join(base, "up");
          await symlink(join(r, ".."), l);
          return join(l, "x", "..", name(r));
        },
      ],
    ];
    const commands: [string, (d: string) => string[]][] = [
      ["open", (d) => ["open", "-d", d]],
      ["auth list", (d) => ["auth", "list", "-d", d]],
    ];
    for (const [cname, cmd] of commands)
      for (const [sname, make] of spellings)
        it(`${cname} with -d ${sname} exits 3 and leaves the root untouched`, async () => {
          const container = await root();
          const dataRoot = join(container, "data");
          await mkdir(dataRoot);
          const base = await root();
          const home = await root();
          const spelled = await make(dataRoot, base);
          const parent = container;
          const before = await readdir(parent);
          const result = runCli(cmd(spelled), dataRoot, home);
          expect(result.status).toBe(3);
          expect(result.stderr).toContain(refusal);
          expect(result.stdout).not.toContain("bl_");
          expect(await readdir(dataRoot)).toEqual([]);
          expect(await readdir(parent)).toEqual(before);
        });
  });

  it("a marker for a different root does not block a scratch data root", async () => {
    const spawningRoot = await root();
    const scratchRoot = await root();
    const home = await root();
    const result = runCli(["project", "list", "-d", scratchRoot], spawningRoot, home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No projects");
  });

  it("checks the BOOF_RUNNER_DATA_ROOT environment root", async () => {
    const dataRoot = await root();
    const home = await root();
    const result = runCli(
      ["auth", "clients", "create", "--name", "pwn", "--scopes", "admin"],
      dataRoot,
      home,
      { BOOF_RUNNER_DATA_ROOT: dataRoot },
    );
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(refusal);
    expect(await readdir(dataRoot)).toEqual([]);
  });

  it("bare --version works when the marker matches the default root", async () => {
    const home = await root();
    const dataRoot = join(process.cwd(), "data");
    const result = runCli(["--version"], dataRoot, home);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
