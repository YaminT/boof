import { describe, expect, it } from "vitest";
import {
  agentStatus,
  bootIdentity,
  probeProcess,
  sameBoot,
  type AgentIdentity,
  type IdentityDeps,
} from "./process-identity.js";

/** A fake `run` that answers by the command and records what was asked. */
function fakeRun(answers: Record<string, string | null>) {
  const calls: string[] = [];
  const run: IdentityDeps["run"] = (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    for (const [prefix, out] of Object.entries(answers)) if (key.includes(prefix)) return out;
    return null;
  };
  return { run, calls };
}

describe("macOS (mocked: no Mac here)", () => {
  const BOOT = "{ sec = 1730000000, usec = 123456 } Fri Nov  1 08:00:00 2026\n";
  const PS = "  4321 Mon Nov  2 17:30:07 2026\n";

  it("reads the boot time from kern.boottime and the process from ps", () => {
    const { run, calls } = fakeRun({ "kern.boottime": BOOT, "ps ": PS });
    const deps = { platform: "darwin" as const, run };
    expect(bootIdentity(deps)).toBe("boottime:1730000000");
    expect(probeProcess(100, deps)).toEqual({
      startTicks: null,
      startTime: "Mon Nov  2 17:30:07 2026",
      ppid: 4321,
    });
    expect(calls.some((c) => c.startsWith("sysctl -n kern.boottime"))).toBe(true);
    expect(calls.some((c) => /^ps -o ppid=,lstart= -p 100$/.test(c))).toBe(true);
  });

  it("a missing process or a failed command is unknown, never a guess", () => {
    const { run } = fakeRun({});
    expect(probeProcess(100, { platform: "darwin", run })).toBeUndefined();
    expect(bootIdentity({ platform: "darwin", run })).toBeNull();
    const garbled = fakeRun({ "ps ": "nonsense", "kern.boottime": "nonsense" });
    expect(probeProcess(100, { platform: "darwin", run: garbled.run })).toBeUndefined();
    expect(bootIdentity({ platform: "darwin", run: garbled.run })).toBeNull();
  });
});

describe("Windows (mocked: no Windows here)", () => {
  it("reads boot time and creation time through PowerShell CIM", () => {
    const { run, calls } = fakeRun({
      LastBootUpTime: "2026-11-01T08:00:00.5000000Z\r\n",
      Win32_Process: "2026-11-02T17:30:07.1234567Z|777\r\n",
    });
    const deps = { platform: "win32" as const, run };
    expect(bootIdentity(deps)).toBe(
      `boottime:${Math.floor(Date.parse("2026-11-01T08:00:00.500Z") / 1000)}`,
    );
    expect(probeProcess(100, deps)).toEqual({
      startTicks: null,
      startTime: "2026-11-02T17:30:07.1234567Z",
      ppid: 777,
    });
    expect(calls.every((c) => c.startsWith("powershell"))).toBe(true);
  });

  it("falls back to wmic when PowerShell gives nothing", () => {
    const { run, calls } = fakeRun({
      "os get LastBootUpTime": "\r\nLastBootUpTime=20261101080000.500000+000\r\n\r\n",
      "process where ProcessId=100":
        "\r\nCreationDate=20261102173007.123456+000\r\nParentProcessId=777\r\n\r\n",
    });
    const deps = { platform: "win32" as const, run };
    expect(bootIdentity(deps)).toBe(`boottime:${Date.UTC(2026, 10, 1, 8, 0, 0) / 1000}`);
    expect(probeProcess(100, deps)).toEqual({
      startTicks: null,
      startTime: "20261102173007.123456+000",
      ppid: 777,
    });
    expect(calls.some((c) => c.startsWith("powershell"))).toBe(true);
    expect(calls.some((c) => c.startsWith("wmic"))).toBe(true);
  });

  it("refuses a pid that is not a plain positive integer before running anything", () => {
    const { run, calls } = fakeRun({});
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      expect(probeProcess(bad, { platform: "win32", run })).toBeUndefined();
    }
    expect(calls).toEqual([]);
  });
});

describe("sameBoot", () => {
  it("compares uuids exactly and boot times within a few seconds", () => {
    expect(sameBoot("abc", "abc")).toBe(true);
    expect(sameBoot("abc", "abd")).toBe(false);
    expect(sameBoot("boottime:1000", "boottime:1004")).toBe(true);
    expect(sameBoot("boottime:1000", "boottime:1030")).toBe(false);
    expect(sameBoot("boottime:1000", "abc")).toBe(false);
    expect(sameBoot(null, "abc")).toBe(false);
    expect(sameBoot("abc", null)).toBe(false);
  });
});

describe("agentStatus", () => {
  const id: AgentIdentity = {
    pgid: 100,
    command: "claude",
    bootId: "boottime:1730000000",
    startTicks: null,
    startTime: "Mon Nov  2 17:30:07 2026",
  };
  const mac = (ps: string | null, boot: string | null = "{ sec = 1730000001, usec = 0 }") =>
    fakeRun({ "kern.boottime": boot, "ps ": ps });

  it("running only when the boot and the exact start time match", () => {
    const m = mac("  1 Mon Nov  2 17:30:07 2026");
    expect(agentStatus(id, { platform: "darwin", run: m.run })).toBe("running");
  });

  it("a reused pid (another start time) or another boot is gone, not running", () => {
    expect(
      agentStatus(id, { platform: "darwin", run: mac("  1 Mon Nov  2 18:00:00 2026").run }),
    ).toBe("gone");
    expect(
      agentStatus(id, {
        platform: "darwin",
        run: mac("  1 Mon Nov  2 17:30:07 2026", "{ sec = 1740000000, usec = 0 }").run,
      }),
    ).toBe("gone");
    expect(agentStatus(id, { platform: "darwin", run: mac(null).run })).toBe("gone");
  });

  it("without a stored start time, or when probing fails, the answer is unknown (never blocks)", () => {
    const m = mac("  1 Mon Nov  2 17:30:07 2026");
    expect(agentStatus({ ...id, startTime: null }, { platform: "darwin", run: m.run })).toBe(
      "unknown",
    );
    expect(agentStatus({ ...id, bootId: null }, { platform: "darwin", run: m.run })).toBe(
      "unknown",
    );
    expect(
      agentStatus(id, { platform: "darwin", run: mac("  1 Mon Nov  2 17:30:07 2026", null).run }),
    ).toBe("unknown");
  });
});
