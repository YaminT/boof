import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  execCommand,
  resetSandboxStatus,
  sandboxSettingsFingerprint,
  setSandboxStatus,
  type SandboxLaunchPolicy,
} from "@boof/heart";
import { prepareAgentLaunch, refreshSandbox, type SandboxSettingsView } from "./index.js";
import { createRunTemp, type AgentLaunchContext } from "./runtime.js";
import { darwin, sandboxSuite } from "./accept-support.js";

const enforce: SandboxSettingsView = {
  mode: "enforce",
  readPaths: [],
  writePaths: [],
  denyTcpPorts: [],
};

const policy: SandboxLaunchPolicy = {
  version: 1,
  readExec: ["/usr"],
  readWrite: ["/tmp"],
  denyTcpPorts: [9],
  env: {},
};

function refusingSpawn() {
  return vi.fn(() => {
    throw new Error("spawned");
  });
}

sandboxSuite("sandbox acceptance: fail closed, policy and mode off", () => {
  const scratch: string[] = [];

  afterEach(async () => {
    resetSandboxStatus();
    await Promise.all(scratch.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("A14 refuses a missing helper, a corrupted policy and ABI 3 before any process is spawned", async () => {
    if (darwin) {
      await expectA14Darwin();
      return;
    }
    const missing = refusingSpawn();
    await expect(
      execCommand(
        "true",
        [],
        { cwd: "/tmp", launch: { kind: "sandbox", helper: "/no/such/boof-sandbox", policy } },
        { spawn: missing },
      ),
    ).rejects.toMatchObject({
      code: "sandbox_unavailable",
      message: expect.stringContaining("sandbox_unavailable"),
    });
    expect(missing).not.toHaveBeenCalled();

    const corrupt = refusingSpawn();
    await expect(
      execCommand(
        "true",
        [],
        {
          cwd: "/tmp",
          launch: {
            kind: "sandbox",
            helper: process.execPath,
            policy: { ...policy, extra: true } as SandboxLaunchPolicy,
          },
        },
        { spawn: corrupt },
      ),
    ).rejects.toMatchObject({
      code: "sandbox_unavailable",
      message: "sandbox_unavailable: sandbox policy is corrupt",
    });
    expect(corrupt).not.toHaveBeenCalled();

    const abiSpawn = refusingSpawn();
    const probes = vi.fn();
    const status = await refreshSandbox(
      { runner: { sandbox: enforce } },
      {
        platform: "linux",
        env: { BOOF_SANDBOX_FAKE_ABI: "3" },
        spawn: abiSpawn,
        probes,
      },
      { force: true },
    );
    expect(status).toMatchObject({
      state: "unavailable",
      reason: "landlock abi 3 is below 4",
    });
    expect(abiSpawn).not.toHaveBeenCalled();
    expect(probes).not.toHaveBeenCalled();
    await expect(prepareAgentLaunch({ runner: { sandbox: enforce } })).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
  });

  it("A15 throws when the writable folder contains the data root or an allowed path is an ancestor of it", async () => {
    const base = await mkdtemp(join(tmpdir(), "boof-i1f-a15-"));
    scratch.push(base);
    const home = join(base, "home");
    const project = join(base, "project");
    const dataInside = join(project, "data");
    const work = join(base, "work");
    const state = join(base, "state");
    await mkdir(home);
    await mkdir(dataInside, { recursive: true });
    await mkdir(work);
    await mkdir(state);
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: home,
      XDG_STATE_HOME: state,
    };
    setSandboxStatus(
      { mode: "enforce", backend: "linux", state: "ok", reason: "" },
      sandboxSettingsFingerprint(enforce),
    );
    const tempInside = await createRunTemp({ dataRoot: dataInside, projectId: "proj", env });
    const contains: AgentLaunchContext = {
      dataRoot: dataInside,
      projectId: "proj",
      tool: "mock",
      writableRoot: project,
      mainCheckout: project,
      runTempDir: tempInside,
      env,
      helper: process.execPath,
    };
    await expect(prepareAgentLaunch({ runner: { sandbox: enforce } }, contains)).rejects.toThrow(
      /contains the data root/,
    );

    const data = join(base, "repo", "data");
    await mkdir(data, { recursive: true });
    const ancestorSettings: SandboxSettingsView = {
      ...enforce,
      readPaths: [join(base, "repo")],
    };
    setSandboxStatus(
      { mode: "enforce", backend: "linux", state: "ok", reason: "" },
      sandboxSettingsFingerprint(ancestorSettings),
    );
    const temp = await createRunTemp({ dataRoot: data, projectId: "proj", env });
    const ancestor: AgentLaunchContext = {
      dataRoot: data,
      projectId: "proj",
      tool: "mock",
      writableRoot: work,
      mainCheckout: work,
      runTempDir: temp,
      env,
      helper: process.execPath,
    };
    await expect(
      prepareAgentLaunch({ runner: { sandbox: ancestorSettings } }, ancestor),
    ).rejects.toThrow(/ancestor of it/);
  }, 30_000);

  it("A16 keeps spawn arguments byte-identical to a direct launch when the sandbox is off", async () => {
    const off: SandboxSettingsView = { ...enforce, mode: "off" };
    const launch = await prepareAgentLaunch({ runner: { sandbox: off } });
    expect(launch).toEqual({ kind: "direct" });
    const cwd = "/tmp";
    const env = { PATH: "/bin" };
    const child = fakeChild();
    const fromMode = vi.fn(() => child);
    await execCommand("git", ["status"], { cwd, env, launch }, { spawn: fromMode });
    const child2 = fakeChild();
    const direct = vi.fn(() => child2);
    await execCommand(
      "git",
      ["status"],
      { cwd, env, launch: { kind: "direct" } },
      { spawn: direct },
    );
    expect(fromMode.mock.calls).toEqual(direct.mock.calls);
    expect(fromMode.mock.calls[0]?.[2]).toEqual({
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    expect(fromMode.mock.calls[0]?.[2].env).toBe(env);
  });
});

/**
 * macOS has no helper binary and no Landlock ABI. The same row is a missing sandbox-exec,
 * a corrupt policy, a path that cannot be quoted, and a failed self-test. None of them spawn.
 */
async function expectA14Darwin(): Promise<void> {
  const saved = process.env.BOOF_SANDBOX_EXEC;
  const missing = refusingSpawn();
  process.env.BOOF_SANDBOX_EXEC = "/no/such/sandbox-exec";
  try {
    await expect(
      execCommand(
        "true",
        [],
        { cwd: "/tmp", launch: { kind: "sandbox", helper: "/no/such/boof-sandbox", policy } },
        { spawn: missing },
      ),
    ).rejects.toMatchObject({
      code: "sandbox_unavailable",
      message: "sandbox_unavailable: sandbox-exec is missing",
    });
  } finally {
    if (saved === undefined) delete process.env.BOOF_SANDBOX_EXEC;
    else process.env.BOOF_SANDBOX_EXEC = saved;
  }
  expect(missing).not.toHaveBeenCalled();

  const corrupt = refusingSpawn();
  await expect(
    execCommand(
      "true",
      [],
      {
        cwd: "/tmp",
        launch: {
          kind: "sandbox",
          helper: process.execPath,
          policy: { ...policy, extra: true } as SandboxLaunchPolicy,
        },
      },
      { spawn: corrupt },
    ),
  ).rejects.toMatchObject({
    code: "sandbox_unavailable",
    message: "sandbox_unavailable: sandbox policy is corrupt",
  });
  expect(corrupt).not.toHaveBeenCalled();

  for (const path of ['/tmp/bad"path', "/tmp/bad\npath"]) {
    const quoted = refusingSpawn();
    await expect(
      execCommand(
        "true",
        [],
        {
          cwd: "/tmp",
          launch: {
            kind: "sandbox",
            helper: process.execPath,
            policy: { ...policy, readExec: [path] },
          },
        },
        { spawn: quoted },
      ),
    ).rejects.toMatchObject({
      code: "sandbox_unavailable",
      message: "sandbox_unavailable: sandbox policy path contains a quote or newline",
    });
    expect(quoted).not.toHaveBeenCalled();
  }

  const abiSpawn = refusingSpawn();
  const status = await refreshSandbox(
    { runner: { sandbox: enforce } },
    {
      platform: "darwin",
      sandboxExecExists: () => true,
      spawn: abiSpawn,
      probes: async () => [
        { id: "data-root-read", outcome: "allowed" },
        { id: "denied-port", outcome: "denied" },
        { id: "unix-socket", outcome: "denied" },
        { id: "write-outside", outcome: "denied" },
        { id: "signal", outcome: "denied" },
        { id: "write-inside", outcome: "allowed" },
      ],
    },
    { force: true },
  );
  expect(status).toMatchObject({
    state: "unavailable",
    reason: "self-test: read a file inside the data root",
  });
  expect(abiSpawn).not.toHaveBeenCalled();
  await expect(prepareAgentLaunch({ runner: { sandbox: enforce } })).rejects.toMatchObject({
    code: "sandbox_unavailable",
  });
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { write: (chunk?: string) => boolean; end: () => void };
    stdio: unknown[];
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 7;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as typeof child.stdin;
  stdin.write = () => true;
  stdin.end = () => {};
  child.stdin = stdin;
  child.stdio = [stdin, child.stdout, child.stderr];
  child.kill = vi.fn();
  setTimeout(() => child.emit("close", 0, null), 0);
  return child;
}
