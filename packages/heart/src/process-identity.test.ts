import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentStatus,
  bootIdentity,
  killVerified,
  probeEnv,
  startTimeMatches,
  ticksOf,
  probeProcess,
  processTable,
  resetBootCache,
  sameBoot,
  verifiedDescendants,
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
      Win32_Process: "2026-11-02T17:30:07.1234560Z|777\r\n",
    });
    const deps = { platform: "win32" as const, run };
    expect(bootIdentity(deps)).toBe(
      `boottime:${Math.floor(Date.parse("2026-11-01T08:00:00.500Z") / 1000)}`,
    );
    expect(probeProcess(100, deps)).toEqual({
      startTicks: null,
      startTime: "2026-11-02T17:30:07.1234560Z",
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
      fellBack: true,
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
    expect(agentStatus(id, { platform: "darwin", run: mac(null).run, alive: () => false })).toBe(
      "gone",
    );
  });

  it("a probe that fails while the pid is still alive is unknown, never gone", () => {
    const failing = { platform: "darwin" as const, run: mac(null).run };
    expect(agentStatus(id, { ...failing, alive: () => true })).toBe("unknown");
    expect(agentStatus(id, { ...failing, alive: () => false })).toBe("gone");
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

  describe("Windows start times", () => {
    const ISO = "2026-11-02T17:30:07.1234560Z";
    const WMIC = "20261102173007.123456+000";
    const bootSec = Math.floor(Date.parse("2024-11-01T08:00:00Z") / 1000);
    const id = (startTime: string): AgentIdentity => ({
      pgid: 100,
      command: "claude",
      bootId: `boottime:${bootSec}`,
      startTicks: null,
      startTime,
    });
    const win = (answers: Record<string, string | null>) =>
      fakeRun({ LastBootUpTime: "2024-11-01T08:00:00.0000000Z", ...answers });

    it("a wmic probe against a recorded ISO time is unknown, not gone", () => {
      const { run, calls } = win({
        "wmic process": `CreationDate=${WMIC}\r\nParentProcessId=1\r\n`,
      });
      expect(agentStatus(id(ISO), { platform: "win32", run, alive: () => true })).toBe("unknown");
      expect(calls.some((c) => c.startsWith("wmic"))).toBe(true);
    });

    it("a probe that fell back to wmic does not call a different wmic time gone", () => {
      const { run } = win({
        "wmic process": "CreationDate=20261102180000.000000+000\r\nParentProcessId=1\r\n",
      });
      expect(agentStatus(id(WMIC), { platform: "win32", run, alive: () => true })).toBe("unknown");
    });

    it("the same wmic string from a fallback is still the recorded process", () => {
      const { run } = win({
        "wmic process": `CreationDate=${WMIC}\r\nParentProcessId=1\r\n`,
      });
      expect(agentStatus(id(WMIC), { platform: "win32", run })).toBe("running");
    });

    it("two different ISO times are a reused pid and are gone", () => {
      const { run } = win({ Win32_Process: "2026-11-02T19:00:00.0000000Z|1\r\n" });
      expect(agentStatus(id(ISO), { platform: "win32", run })).toBe("gone");
    });
  });
});

describe("probe commands", () => {
  const dirs: string[] = [];
  const oldPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = oldPath;
    resetBootCache();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** A fake command on PATH, so the default runner (execFile) is exercised. */
  function shim(name: string, script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "boof-shim-"));
    dirs.push(dir);
    writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, name), 0o755);
    process.env.PATH = `${dir}${delimiter}${oldPath}`;
    return dir;
  }

  it("the environment forces the C locale, so month and day names are English", () => {
    expect(probeEnv({ LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8", KEEP: "1" })).toMatchObject({
      LC_ALL: "C",
      LANG: "C",
      KEEP: "1",
    });
  });

  it.skipIf(process.platform === "win32")("the default runner runs ps with LC_ALL=C", () => {
    shim("ps", 'echo "  1 lstart-$LC_ALL-$LANG"');
    const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
    process.env.LC_ALL = "de_DE.UTF-8";
    process.env.LANG = "de_DE.UTF-8";
    try {
      expect(probeProcess(4242, { platform: "darwin" })?.startTime).toBe("lstart-C-C");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it.skipIf(process.platform === "win32")("the macOS boot time is read once per process", () => {
    const dir = shim(
      "sysctl",
      'echo x >> "$(dirname "$0")/calls"; echo "{ sec = 1730000000, usec = 5 } Fri Nov  1 08:00:00 2026"',
    );
    expect(bootIdentity({ platform: "darwin" })).toBe("boottime:1730000000");
    expect(bootIdentity({ platform: "darwin" })).toBe("boottime:1730000000");
    expect(readFileSync(join(dir, "calls"), "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("Windows process table", () => {
  const A = "2026-11-02T10:00:00.0000000Z";
  const table = (out: string | null) => processTable({ platform: "win32", run: () => out });

  it("parses pid|ppid|created lines and drops anything else", () => {
    expect(
      table(`10|1|${A}\r\nnot a row\r\n11|10|2026-11-02T10:00:01.0000000Z\r\n12|10|yesterday\r\n`),
    ).toEqual({
      rows: [
        { pid: 10, ppid: 1, created: A },
        { pid: 11, ppid: 10, created: "2026-11-02T10:00:01.0000000Z" },
      ],
      droppedNonIso: 1,
    });
    expect(table(null)).toBeNull();
    expect(table("")).toEqual({ rows: [], droppedNonIso: 0 });
    expect(processTable({ platform: "linux", run: () => "10|1|" + A })).toBeNull();
  });

  it("counts rows whose time is not the fixed UTC form, so an empty table is not a failed query", () => {
    expect(
      table("4242|1|20261102173007.123456+000\r\n5000|4242|20261102173009.000000+000\r\n"),
    ).toEqual({ rows: [], droppedNonIso: 2 });
  });

  it("descendants are the processes created after their parent, deepest first", () => {
    const rows = [
      { pid: 10, ppid: 1, created: "2026-11-02T10:00:00.0000000Z" },
      { pid: 11, ppid: 10, created: "2026-11-02T10:00:01.0000000Z" },
      { pid: 12, ppid: 11, created: "2026-11-02T10:00:02.0000000Z" },
      { pid: 20, ppid: 10, created: "2026-11-02T09:00:00.0000000Z" }, // older: a stranger
      { pid: 21, ppid: 20, created: "2026-11-02T09:30:00.0000000Z" }, // its child: also not ours
      { pid: 30, ppid: 10, created: "2026-11-02T10:00:00.0000000Z" }, // same instant: not provably after
      { pid: 40, ppid: 12, created: "2026-11-02T10:00:01.5000000Z" }, // before its parent (12)
    ];
    expect(verifiedDescendants(10, rows)).toEqual([12, 11]);
    expect(verifiedDescendants(99, rows)).toEqual([]);
  });
});

describe("killVerified", () => {
  const T = "2026-11-02T10:00:00.0000000Z";
  it("refuses a pid that is not a positive integer or a time that is not the fixed UTC form, before running anything", () => {
    const calls: string[] = [];
    const deps = { platform: "win32" as const, run: (c: string) => (calls.push(c), "") };
    for (const bad of [
      { pid: 0, created: T },
      { pid: 1.5, created: T },
      { pid: 7, created: "yesterday" },
      { pid: 7, created: `${T}'; calc` },
    ]) {
      expect(killVerified([bad], deps)).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("runs one PowerShell process with the pairs on stdin", () => {
    const seen: { cmd: string; input?: string }[] = [];
    const deps = {
      platform: "win32" as const,
      run: (cmd: string, _a: string[], o?: { input?: string }) => (
        seen.push({ cmd, input: o?.input }),
        ""
      ),
    };
    expect(killVerified([{ pid: 7, created: T }], deps)).toBe(true);
    expect(seen).toEqual([
      { cmd: "powershell", input: JSON.stringify([{ pid: 7, ticks: ticksOf(T) }]) },
    ]);
  });
});

describe("start times in ticks", () => {
  it("ticksOf is the 100 ns count since the Unix epoch, as a digit string (no date conversion by ConvertFrom-Json)", () => {
    expect(ticksOf("1970-01-01T00:00:00.0000000Z")).toBe("0");
    expect(ticksOf("1970-01-01T00:00:01.0000010Z")).toBe("10000010");
    expect(ticksOf("2026-11-02T17:30:07.1234560Z")).toBe(
      String(BigInt(Date.parse("2026-11-02T17:30:07Z") / 1000) * 10_000_000n + 1234560n),
    );
    expect(() => ticksOf("yesterday")).toThrow();
  });

  it("a held process matches when its StartTime, cut to whole microseconds, equals the CIM time", () => {
    const cim = BigInt(ticksOf("2026-11-02T17:30:07.1234560Z"));
    // Process.StartTime keeps 100 ns: the 7th digit is usually not 0.
    for (const sub of [0n, 1n, 7n, 9n]) expect(startTimeMatches(cim + sub, cim)).toBe(true);
    expect(startTimeMatches(cim + 10n, cim)).toBe(false); // a different microsecond
    expect(startTimeMatches(cim - 1n, cim)).toBe(false);
  });
});
