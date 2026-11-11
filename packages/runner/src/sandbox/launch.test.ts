import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SandboxUnavailableError,
  execCommand,
  resetSandboxStatus,
  sandboxApplier,
  sandboxSettingsFingerprint,
  setSandboxApplier,
  setSandboxStatus,
  type ExecOptions,
  type SandboxLaunchPolicy,
} from "@boof/heart";
import { transientReason } from "../tools/errors.js";
import { planLinuxSandbox } from "./backend-linux.js";
import { prepareAgentLaunch, refreshSandbox, type SandboxSettingsView } from "./index.js";
import { SIGNALS_NOT_SCOPED, judgeSelfTest } from "./selftest.js";

const offSandbox: SandboxSettingsView = {
  mode: "off",
  readPaths: [],
  writePaths: [],
  denyTcpPorts: [],
};
const enforceSandbox: SandboxSettingsView = { ...offSandbox, mode: "enforce" };

const policy: SandboxLaunchPolicy = {
  version: 1,
  readExec: ["/usr"],
  readWrite: ["/tmp"],
  denyTcpPorts: [9],
  env: { FOO: "bar" },
};

const passingProbes = [
  { id: "data-root-read", outcome: "denied" },
  { id: "denied-port", outcome: "denied" },
  { id: "unix-socket", outcome: "denied" },
  { id: "write-outside", outcome: "denied" },
  { id: "signal", outcome: "denied" },
  { id: "write-inside", outcome: "allowed" },
];

const probeReason: Record<string, string> = {
  "data-root-read": "self-test: read a file inside the data root",
  "denied-port": "self-test: connected to a denied TCP port",
  "unix-socket": "self-test: connected to a pathname unix socket",
  "write-outside": "self-test: wrote outside the allowed folder",
  signal: "self-test: signalled the server",
  "write-inside": "self-test: could not write inside the allowed folder",
};

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { write: (chunk?: string) => boolean; end: () => void };
    stdio: Array<{
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
    }>;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 7;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as typeof child.stdin;
  stdin.write = () => true;
  stdin.end = () => {};
  child.stdin = stdin;
  const pipe = { write: vi.fn(() => true), end: vi.fn(), on: vi.fn() };
  child.stdio = [stdin as never, child.stdout as never, child.stderr as never, pipe];
  child.kill = vi.fn();
  setTimeout(() => child.emit("close", 0, null), 0);
  return child;
}

function refusingSpawn() {
  return vi.fn(() => {
    throw new Error("spawned");
  });
}

beforeEach(() => {
  resetSandboxStatus();
  if (process.platform === "linux") setSandboxApplier(planLinuxSandbox);
});

afterEach(() => {
  resetSandboxStatus();
  setSandboxApplier(process.platform === "linux" ? planLinuxSandbox : undefined);
});

describe("A14 sandbox refusals spawn nothing", () => {
  it("refuses a missing helper before spawn", async () => {
    const spawn = refusingSpawn();
    await expect(
      execCommand(
        "true",
        ["--flag"],
        {
          cwd: "/tmp",
          launch: { kind: "sandbox", helper: "/no/such/boof-sandbox", policy },
        },
        { spawn },
      ),
    ).rejects.toMatchObject({
      code: "sandbox_unavailable",
      message: "sandbox_unavailable: boof-sandbox helper is missing",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["an extra field", { ...policy, extra: true }],
    ["version 2", { ...policy, version: 2 }],
    ["a relative path", { ...policy, readExec: ["usr"] }],
    ["port 0", { ...policy, denyTcpPorts: [0] }],
  ])("refuses a corrupted policy (%s) before spawn", async (_label, corrupt) => {
    const spawn = refusingSpawn();
    await expect(
      execCommand(
        "true",
        [],
        {
          cwd: "/tmp",
          launch: {
            kind: "sandbox",
            helper: process.execPath,
            policy: corrupt as SandboxLaunchPolicy,
          },
        },
        { spawn },
      ),
    ).rejects.toMatchObject({
      code: "sandbox_unavailable",
      message: "sandbox_unavailable: sandbox policy is corrupt",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses ABI 3 before the helper or any probe runs", async () => {
    const spawn = refusingSpawn();
    const probes = vi.fn();
    const status = await refreshSandbox(
      { runner: { sandbox: enforceSandbox } },
      {
        platform: "linux",
        env: { BOOF_SANDBOX_FAKE_ABI: "3" },
        spawn,
        probes,
      },
      { force: true },
    );
    expect(status).toMatchObject({
      state: "unavailable",
      reason: "landlock abi 3 is below 4",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(probes).not.toHaveBeenCalled();
  });

  it("treats a non-integer fake ABI as unavailable and does not spawn", async () => {
    const spawn = refusingSpawn();
    const status = await refreshSandbox(
      { runner: { sandbox: enforceSandbox } },
      {
        platform: "linux",
        env: { BOOF_SANDBOX_FAKE_ABI: "3.0" },
        spawn,
        probes: vi.fn(),
      },
      { force: true },
    );
    expect(status.reason).toBe("BOOF_SANDBOX_FAKE_ABI is not an integer");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reads 03 as ABI 3", async () => {
    const status = await refreshSandbox(
      { runner: { sandbox: enforceSandbox } },
      { platform: "linux", env: { BOOF_SANDBOX_FAKE_ABI: "03" }, spawn: refusingSpawn() },
      { force: true },
    );
    expect(status.reason).toBe("landlock abi 3 is below 4");
  });
});

describe("A16 direct launch", () => {
  it("keeps today's spawn arguments and the env object", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const cwd = "/tmp";
    await execCommand("git", ["status"], { cwd, launch: { kind: "direct" } }, { spawn });
    expect(spawn).toHaveBeenCalledWith("git", ["status"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const env = { PATH: "/bin" };
    const child2 = fakeChild();
    const spawn2 = vi.fn(() => child2);
    await execCommand(
      "git",
      ["status"],
      { cwd, env, launch: { kind: "direct" } },
      { spawn: spawn2 },
    );
    expect(spawn2.mock.calls[0]?.[2]).toEqual({
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    expect(spawn2.mock.calls[0]?.[2].env).toBe(env);
  });
});

describe("self-test probes", () => {
  async function refresh(results: { id: string; outcome: string }[], abi: string) {
    const spawn = refusingSpawn();
    const probes = vi.fn(async () => results);
    const status = await refreshSandbox(
      { runner: { sandbox: enforceSandbox } },
      {
        platform: "linux",
        env: { BOOF_SANDBOX_FAKE_ABI: abi, BOOF_SANDBOX_HELPER: "/no/such/boof-sandbox" },
        helperExists: () => true,
        spawn,
        probes,
      },
      { force: true },
    );
    expect(spawn).not.toHaveBeenCalled();
    return status;
  }

  for (const id of ["data-root-read", "denied-port", "unix-socket", "write-outside", "signal"]) {
    it(`fails when ${id} is allowed on its own`, async () => {
      const results = passingProbes.map((probe) =>
        probe.id === id ? { ...probe, outcome: "allowed" } : probe,
      );
      const status = await refresh(results, "8");
      expect(status).toMatchObject({ state: "unavailable", reason: probeReason[id] });
    });
  }

  it("fails when the write inside the allowed folder is denied on its own", async () => {
    const results = passingProbes.map((probe) =>
      probe.id === "write-inside" ? { ...probe, outcome: "denied" } : probe,
    );
    const status = await refresh(results, "8");
    expect(status).toMatchObject({ state: "unavailable", reason: probeReason["write-inside"] });
  });

  it("does not treat an error outcome as denied", () => {
    const results = passingProbes.map((probe) =>
      probe.id === "data-root-read" ? { ...probe, outcome: "error:ENOENT" } : probe,
    );
    expect(judgeSelfTest(results, 8)).toEqual({
      ok: false,
      reason: probeReason["data-root-read"],
    });
  });

  it("passes ABI 8 with an empty reason", async () => {
    const status = await refresh(passingProbes, "8");
    expect(status).toEqual({ mode: "enforce", backend: "linux", state: "ok", reason: "" });
  });

  it("passes ABI 5 when the signal probe is allowed and says signals are not scoped", async () => {
    const results = passingProbes.map((probe) =>
      probe.id === "signal" ? { ...probe, outcome: "allowed" } : probe,
    );
    const status = await refresh(results, "5");
    expect(status).toEqual({
      mode: "enforce",
      backend: "linux",
      state: "ok",
      reason: SIGNALS_NOT_SCOPED,
    });
  });

  it("passes ABI 4 without a signal probe and keeps the kernel reason", () => {
    const results = passingProbes.filter((probe) => probe.id !== "signal");
    expect(judgeSelfTest(results, 4)).toEqual({ ok: true, reason: SIGNALS_NOT_SCOPED });
  });
});

describe("resolveSandbox", () => {
  it("does not run the canary when the sandbox is off", async () => {
    const spawn = refusingSpawn();
    const probes = vi.fn();
    const status = await refreshSandbox(
      { runner: { sandbox: offSandbox } },
      {
        platform: "linux",
        env: { BOOF_SANDBOX_FAKE_ABI: "3" },
        spawn,
        probes,
      },
      { force: true },
    );
    expect(status).toEqual({
      mode: "off",
      backend: "linux",
      state: "off",
      reason: "agents are not sandboxed",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(probes).not.toHaveBeenCalled();
  });

  it("reports darwin enforce unavailable and does not spawn", async () => {
    const spawn = refusingSpawn();
    const status = await refreshSandbox(
      { runner: { sandbox: enforceSandbox } },
      { platform: "darwin", spawn, probes: vi.fn() },
      { force: true },
    );
    expect(status).toEqual({
      mode: "enforce",
      backend: "darwin",
      state: "unavailable",
      reason: "macOS sandbox backend is not available until I1g",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports windows enforce unavailable and does not spawn", async () => {
    const spawn = refusingSpawn();
    const status = await refreshSandbox(
      { runner: { sandbox: enforceSandbox } },
      { platform: "win32", spawn, probes: vi.fn() },
      { force: true },
    );
    expect(status).toEqual({
      mode: "enforce",
      backend: "none",
      state: "unavailable",
      reason: "Windows has no sandbox backend; enforce cannot run agents",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports a missing helper and does not spawn", async () => {
    const spawn = refusingSpawn();
    const status = await refreshSandbox(
      { runner: { sandbox: enforceSandbox } },
      {
        platform: "linux",
        env: {},
        helperExists: () => false,
        helperPath: () => "/no/such/boof-sandbox",
        spawn,
        probes: vi.fn(),
      },
      { force: true },
    );
    expect(status.reason).toBe("boof-sandbox helper is missing");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("writes the policy without env when the launch is valid", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    await execCommand(
      "agent",
      ["--print"],
      {
        cwd: "/tmp",
        env: { PATH: "/bin" },
        launch: { kind: "sandbox", helper: process.execPath, policy },
      },
      { spawn },
    );
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["--policy-fd", "3", "--", "agent", "--print"],
      expect.objectContaining({
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        env: { PATH: "/bin", FOO: "bar" },
      }),
    );
    const written = String(child.stdio[3]?.write.mock.calls[0]?.[0]);
    expect(JSON.parse(written)).toEqual({
      version: 1,
      readExec: ["/usr"],
      readWrite: ["/tmp"],
      denyTcpPorts: [9],
    });
  });

  it("refuses when no backend is registered", async () => {
    const previous = sandboxApplier();
    setSandboxApplier(undefined);
    const spawn = refusingSpawn();
    try {
      await expect(
        execCommand(
          "true",
          [],
          {
            cwd: "/tmp",
            launch: { kind: "sandbox", helper: process.execPath, policy },
          },
          { spawn },
        ),
      ).rejects.toMatchObject({
        code: "sandbox_unavailable",
        message: "sandbox_unavailable: no sandbox backend is registered",
      });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      setSandboxApplier(previous);
    }
  });

  it("refuses a missing launch before spawn", async () => {
    const spawn = refusingSpawn();
    await expect(
      execCommand("true", [], { cwd: "/tmp" } as Omit<ExecOptions, "launch">, { spawn }),
    ).rejects.toMatchObject({
      code: "sandbox_unavailable",
      message: "sandbox_unavailable: spawn launch is missing",
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("prepareAgentLaunch", () => {
  it("returns direct when the sandbox is off", () => {
    expect(prepareAgentLaunch({ runner: { sandbox: offSandbox } })).toEqual({ kind: "direct" });
  });

  it("throws before spawn when enforce has not passed the self-test", () => {
    expect(() => prepareAgentLaunch({ runner: { sandbox: enforceSandbox } })).toThrow(
      /sandbox self-test has not run/,
    );
  });

  it("throws when the self-test passed and no per-task policy is ready", () => {
    setSandboxStatus(
      { mode: "enforce", backend: "linux", state: "ok", reason: "" },
      sandboxSettingsFingerprint(enforceSandbox),
    );
    expect(() => prepareAgentLaunch({ runner: { sandbox: enforceSandbox } })).toThrow(
      /sandbox policy is not ready for this step/,
    );
  });

  it("is not a transient tool error", () => {
    const err = new SandboxUnavailableError("sandbox policy is corrupt");
    expect(err.message.includes("temporarily unavailable")).toBe(false);
    expect(transientReason(err)).toBeNull();
  });
});
