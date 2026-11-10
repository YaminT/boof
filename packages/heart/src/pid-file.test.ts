import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentBootIdentity,
  isAlive,
  killGroup,
  readPidFile,
  reapOrphan,
  writePidFile,
  type PidRecord,
} from "./pid-file.js";
import { ticksOf } from "./process-identity.js";

let dir: string;
const spawned: number[] = [];
beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), "boof-pid-"))));
afterEach(async () => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const sleeper = (script = "setTimeout(()=>{},60000)") => {
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  spawned.push(child.pid!);
  return child;
};
const exited = (child: ReturnType<typeof spawn>) =>
  new Promise<void>((r) => child.on("exit", () => r()));

describe("pid file", () => {
  it("round-trips the record, creating the control directory", async () => {
    const path = join(dir, "control", "pid");
    await writePidFile(path, { pgid: 4242, command: "claude" });
    const rec = await readPidFile(path);
    expect(rec).toMatchObject({ pgid: 4242, command: "claude", bootId: currentBootIdentity() });
    expect(rec?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(rec);
  });

  it("reads nothing from a missing or malformed file", async () => {
    expect(await readPidFile(join(dir, "nope"))).toBeUndefined();
    await writeFile(join(dir, "bad"), "{not json");
    expect(await readPidFile(join(dir, "bad"))).toBeUndefined();
    await writeFile(join(dir, "neg"), JSON.stringify({ pgid: -1, command: "x" }));
    expect(await readPidFile(join(dir, "neg"))).toBeUndefined();
  });

  it("isAlive distinguishes a running child from a finished one", async () => {
    const child = sleeper();
    expect(isAlive(child.pid!)).toBe(true);
    const gone = exited(child);
    process.kill(-child.pid!, "SIGKILL");
    await gone;
    expect(isAlive(child.pid!)).toBe(false);
  });

  it("killGroup ends a group with SIGTERM, and with SIGKILL when SIGTERM is ignored", async () => {
    const polite = sleeper();
    const politeGone = exited(polite);
    expect(await killGroup(polite.pid!, { termWaitMs: 5_000 })).toBe("exited");
    await politeGone;
    const stubborn = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    spawned.push(stubborn.pid!);
    await new Promise((r) => stubborn.stdout!.once("data", r));
    const stubbornGone = exited(stubborn);
    expect(await killGroup(stubborn.pid!, { termWaitMs: 300, killWaitMs: 5_000 })).toBe("killed");
    await stubbornGone;
    expect(isAlive(stubborn.pid!)).toBe(false);
  });

  it("killGroup never signals init or the runner itself", async () => {
    for (const pid of [0, 1, -1, process.pid]) expect(await killGroup(pid)).toBe("survived");
  });

  describe("reapOrphan off Linux", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    const setPlatform = (value: string) =>
      Object.defineProperty(process, "platform", { ...original, value });
    afterEach(() => Object.defineProperty(process, "platform", original));

    it("keeps the record of a live process, kills nothing, and reports it", async () => {
      const log: string[] = [];
      const path = join(dir, "pid");
      const live = sleeper();
      await writePidFile(path, { pgid: live.pid!, command: "node", ownerPid: null });
      setPlatform("darwin");
      const r = await reapOrphan(path, (l) => log.push(l));
      expect(r).toMatchObject({ outcome: "skipped", maybeRunning: true });
      expect(r.record?.pgid).toBe(live.pid);
      expect(existsSync(path)).toBe(true);
      expect(isAlive(live.pid!)).toBe(true);
      expect(log.join("\n")).toContain("may still be running");
    });

    it("removes the record of a process that has ended", async () => {
      const path = join(dir, "pid");
      const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await exited(gone);
      await writePidFile(path, { pgid: gone.pid!, command: "node" });
      setPlatform("darwin");
      const r = await reapOrphan(path, () => {});
      expect(r.outcome).toBe("dead");
      expect(r.maybeRunning).toBeUndefined();
      expect(existsSync(path)).toBe(false);
    });
  });

  it.skipIf(!currentBootIdentity())(
    "reapOrphan: none / dead / killed / another boot / forged / owner alive",
    async () => {
      const log: string[] = [];
      const path = join(dir, "pid");
      expect((await reapOrphan(path, (l) => log.push(l))).outcome).toBe("none");

      const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await exited(gone);
      await writePidFile(path, { pgid: gone.pid!, command: "node" });
      expect((await reapOrphan(path, (l) => log.push(l))).outcome).toBe("dead");
      expect(existsSync(path)).toBe(false);

      const live = sleeper();
      const liveGone = exited(live);
      await writePidFile(path, { pgid: live.pid!, command: "node", ownerPid: null });
      const killed = await reapOrphan(path, (l) => log.push(l));
      expect(killed).toMatchObject({
        outcome: "killed",
        record: { pgid: live.pid, command: "node" },
      });
      await liveGone;
      expect(log.at(-1)).toBe(`killed orphaned agent process group ${live.pid} (node): exited`);
      expect(existsSync(path)).toBe(false);

      const other = sleeper();
      await writePidFile(path, { pgid: other.pid!, command: "node", bootId: "not-this-boot" });
      expect((await reapOrphan(path, (l) => log.push(l))).outcome).toBe("skipped");
      expect(isAlive(other.pid!)).toBe(true);
      expect(log.at(-1)).toBe(`pid file is from another boot (${other.pid}); not killing`);
      expect(existsSync(path)).toBe(false);

      // A live process that leads no group (a plain child of this runner shares its group) is
      // not a group at all: nothing is signalled, and the answer does not wait.
      const member = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
        stdio: "ignore",
      });
      try {
        await writePidFile(path, { pgid: member.pid!, command: "node", ownerPid: null });
        const t0 = Date.now();
        expect((await reapOrphan(path, (l) => log.push(l))).outcome).toBe("dead");
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(isAlive(member.pid!)).toBe(true);
      } finally {
        member.kill("SIGKILL");
      }

      // A forged record naming a real older group leader with the wrong start time.
      const older = sleeper();
      await writePidFile(path, { pgid: older.pid!, command: "node", ownerPid: null });
      const rec = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...rec, startTicks: rec.startTicks - 1 }));
      expect((await reapOrphan(path, (l) => log.push(l))).outcome).toBe("skipped");
      expect(log.at(-1)).toContain("not the recorded agent group leader");
      expect(isAlive(older.pid!)).toBe(true);
      expect(existsSync(path)).toBe(false);

      // A record from an older version (no start time) is never killed.
      await writePidFile(path, {
        pgid: older.pid!,
        command: "node",
        ownerPid: null,
        startTicks: null,
      });
      expect((await reapOrphan(path, (l) => log.push(l))).outcome).toBe("skipped");
      expect(log.at(-1)).toContain("no process start time");
      expect(isAlive(older.pid!)).toBe(true);

      // While the recording runner is alive and still the leader's parent, nothing is killed
      // and the file stays.
      await writePidFile(path, { pgid: older.pid!, command: "node", ownerPid: process.pid });
      expect((await reapOrphan(path, (l) => log.push(l))).outcome).toBe("skipped");
      expect(log.at(-1)).toContain("is still running");
      expect(isAlive(older.pid!)).toBe(true);
      expect(existsSync(path)).toBe(true);

      // Once the owner is gone the same record is reaped, including a group member that
      // outlives its leader being a separate concern: the whole group is signalled.
      await writePidFile(path, { pgid: older.pid!, command: "node", ownerPid: null });
      expect((await reapOrphan(path, (l) => log.push(l))).outcome).toBe("killed");
    },
  );
});

// macOS and Windows have no /proc: the identity comes from `ps` / `sysctl` and PowerShell. There is
// no Mac or Windows in CI, so these tests run the real reaper against mocked platforms and mocked
// command output; nothing here proves the commands behave so on a real machine.
describe("reapOrphan off Linux (mocked platforms)", () => {
  const BOOT = "{ sec = 1730000000, usec = 5 } Fri Nov  1 08:00:00 2026";
  const STARTED = "Mon Nov  2 17:30:07 2026";
  const rec = (over: Partial<PidRecord> = {}): PidRecord => ({
    pgid: 4242,
    command: "claude",
    startedAt: "2026-11-02T17:30:07.000Z",
    bootId: "boottime:1730000000",
    startTicks: null,
    startTime: STARTED,
    ownerPid: null,
    ...over,
  });
  const write = async (r: PidRecord) => {
    const path = join(dir, "pid");
    await writeFile(path, JSON.stringify(r));
    return path;
  };
  /** A mac whose `ps` says `lstart` (null: no such process). */
  const mac = (
    lstart: string | null,
    ppid = 1,
    boot: string | null = BOOT,
    /** The runner's own `pgid sess`, the agent group leader's `sess`. */
    groups = { self: "777 0xself", leader: "0xagent" },
  ) => ({
    platform: "darwin" as const,
    run: (cmd: string, args: string[] = []) => {
      if (cmd === "sysctl") return boot;
      if (cmd !== "ps") return null;
      if (args.includes("pgid=,sess=")) return `  ${groups.self}\n`;
      if (args.includes("sess=")) return `  ${groups.leader}\n`;
      return lstart === null ? null : `  ${ppid} ${lstart}\n`;
    },
  });
  const logs: string[] = [];
  const log = (l: string) => void logs.push(l);
  beforeEach(() => void (logs.length = 0));

  it("macOS: kills the recorded group only when boot and start time match, then removes the record", async () => {
    const path = await write(rec());
    const killed: number[] = [];
    const res = await reapOrphan(path, log, {
      identity: mac(STARTED),
      kill: async (r) => (killed.push(r.pgid), "killed"),
      isAlive: () => true,
    });
    expect(res.outcome).toBe("killed");
    expect(killed).toEqual([4242]);
    expect(existsSync(path)).toBe(false);
  });

  it("macOS: a reused pid (another start time) is never killed", async () => {
    const path = await write(rec());
    const killed: number[] = [];
    const res = await reapOrphan(path, log, {
      identity: mac("Mon Nov  2 18:00:00 2026"),
      kill: async (r) => (killed.push(r.pgid), "killed"),
      isAlive: () => true,
    });
    expect(res.outcome).toBe("dead");
    expect(killed).toEqual([]);
  });

  it("macOS: another boot, no start time, or no boot identity is never killed", async () => {
    for (const [name, record, identity] of [
      ["another boot", rec(), mac(STARTED, 1, "{ sec = 1750000000, usec = 0 }")],
      ["no start time", rec({ startTime: null }), mac(STARTED)],
      ["no recorded boot", rec({ bootId: null }), mac(STARTED)],
      ["boot unreadable", rec(), mac(STARTED, 1, null)],
    ] as const) {
      const path = await write(record);
      const killed: number[] = [];
      const res = await reapOrphan(path, log, {
        identity,
        kill: async (r) => (killed.push(r.pgid), "killed"),
        isAlive: () => false,
      });
      expect(killed, name).toEqual([]);
      expect(res.outcome === "dead" || res.outcome === "skipped", name).toBe(true);
    }
  });

  it("macOS: a process that is alive but cannot be verified is reported, not killed, and its record stays", async () => {
    const path = await write(rec({ startTime: null }));
    const res = await reapOrphan(path, log, {
      identity: mac(STARTED),
      kill: async () => "killed",
      isAlive: () => true,
    });
    expect(res).toMatchObject({ outcome: "skipped", maybeRunning: true });
    expect(existsSync(path)).toBe(true);
    expect(logs.join("\n")).toMatch(/may still be running/);
  });

  it("macOS: a runner that is still the parent keeps its agent", async () => {
    const path = await write(rec({ ownerPid: 99 }));
    const killed: number[] = [];
    const res = await reapOrphan(path, log, {
      identity: mac(STARTED, 99),
      kill: async (r) => (killed.push(r.pgid), "killed"),
      isAlive: (pid) => pid === 99 || pid === 4242,
    });
    expect(res).toMatchObject({ outcome: "skipped", stillRunning: true });
    expect(killed).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it("macOS: an agent that survives the kill is reported as still running", async () => {
    const path = await write(rec());
    const res = await reapOrphan(path, log, {
      identity: mac(STARTED),
      kill: async () => "survived",
      isAlive: () => true,
    });
    expect(res).toMatchObject({ outcome: "skipped", stillRunning: true });
  });

  const WIN_BOOT = "2024-11-01T08:00:00.0000000Z";
  const winBootSec = Math.floor(Date.parse("2024-11-01T08:00:00Z") / 1000);
  const AGENT_START = "2026-11-02T17:30:07.1234560Z";
  type Pair = { pid: number; ticks: string };
  /**
   * A Windows box. `table` is the CIM process table (`pid|ppid|created` lines; null: the query
   * fails). The kill script gets its (pid, created) pairs as JSON on stdin and the agent
   * disappears once its pid is among them; `taskkill` (the fallback) collects its arguments.
   */
  const win = (table: string | null) => {
    const box = {
      pairs: [] as Pair[][],
      scripts: [] as string[],
      scriptArgs: [] as string[][],
      taskkills: [] as string[],
      stopped: false,
      identity: undefined as unknown as {
        platform: "win32";
        run: (cmd: string, args: string[], opts?: { input?: string }) => string | null;
      },
    };
    box.identity = {
      platform: "win32" as const,
      run: (cmd, args, opts) => {
        if (cmd === "taskkill") {
          box.taskkills.push(args.join(" "));
          if (args.includes("4242")) box.stopped = true;
          return "SUCCESS";
        }
        if (cmd !== "powershell") return null;
        const text = args.join(" ");
        if (text.includes("LastBootUpTime")) return WIN_BOOT;
        if (text.includes("-Filter")) return box.stopped ? "" : `${AGENT_START}|1`;
        if (opts?.input !== undefined) {
          const pairs = JSON.parse(opts.input) as Pair[];
          box.pairs.push(pairs);
          box.scripts.push(text);
          box.scriptArgs.push(args);
          if (pairs.some((x) => x.pid === 4242)) box.stopped = true;
          return "";
        }
        return box.stopped ? "" : table;
      },
    };
    return box;
  };
  const winRecord = () => write(rec({ bootId: `boottime:${winBootSec}`, startTime: AGENT_START }));

  it("Windows: stops the agent and its verified children, deepest first, in one PowerShell process, never taskkill /T", async () => {
    const table = [
      `4242|1|${AGENT_START}`,
      `5000|4242|2026-11-02T17:30:09.0000000Z`, // child
      `5001|5000|2026-11-02T17:30:10.0000000Z`, // grandchild
      `9999|1|2026-11-02T17:00:00.0000000Z`,
    ].join("\r\n");
    const box = win(table);
    const path = await winRecord();
    const res = await reapOrphan(path, log, { identity: box.identity, isAlive: () => true });
    expect(res.outcome).toBe("killed");
    expect(box.pairs).toEqual([
      [
        { pid: 5001, ticks: ticksOf("2026-11-02T17:30:10.0000000Z") },
        { pid: 5000, ticks: ticksOf("2026-11-02T17:30:09.0000000Z") },
        { pid: 4242, ticks: ticksOf(AGENT_START) },
      ],
    ]);
    expect(box.taskkills).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it("Windows: the kill script is fixed text; pids and times only travel as JSON on stdin", async () => {
    const box = win([`4242|1|${AGENT_START}`, `5000|4242|2026-11-02T17:30:09.0000000Z`].join("\n"));
    await reapOrphan(await winRecord(), log, { identity: box.identity, isAlive: () => true });
    expect(box.scripts).toHaveLength(1);
    const script = box.scripts[0]!;
    // Opens the process (a held handle keeps the pid from being reused), compares the start time
    // with the one verified from the table, and kills only on a match.
    expect(script).toContain("Get-Process -Id");
    expect(script).toContain("StartTime");
    expect(script).toContain(".Kill()");
    // Compared in UTC ticks, StartTime cut to whole microseconds (CIM has no 7th digit).
    expect(script).toContain("ToUniversalTime().Ticks");
    expect(script).toContain("% 10");
    expect(script).not.toMatch(/4242|5000|2026-11-02/);
    expect(box.scriptArgs[0]).toContain("-NoProfile");
    expect(box.scriptArgs[0]!.join(" ")).not.toMatch(/4242|5000/);
  });

  it("Windows: an older unrelated process that lists the agent's pid as its parent is not killed", async () => {
    const table = [
      `4242|1|${AGENT_START}`,
      // Started before the agent, from a launcher that once had pid 4242; Windows keeps the dead
      // parent's id, so it still says ppid 4242. It, and its own child, are strangers.
      `6000|4242|2026-11-02T08:00:00.0000000Z`,
      `6001|6000|2026-11-02T09:00:00.0000000Z`,
      // Created in the very same instant as the agent: not provably after, so not a child.
      `6002|4242|${AGENT_START}`,
      `5000|4242|2026-11-02T17:30:09.0000000Z`, // the one real child
    ].join("\n");
    const box = win(table);
    const res = await reapOrphan(await winRecord(), log, {
      identity: box.identity,
      isAlive: () => true,
    });
    expect(res.outcome).toBe("killed");
    expect(box.pairs[0]!.map((x) => x.pid)).toEqual([5000, 4242]);
    expect(JSON.stringify(box.pairs)).not.toMatch(/6000|6001|6002/);
    expect(box.taskkills).toEqual([]);
  });

  it("Windows: a readable table whose agent row has another creation time means the agent is gone: nothing is killed", async () => {
    // The agent exited between the probe and the table read and its pid was reused.
    for (const table of [
      `4242|1|2026-11-02T17:31:00.0000000Z\n5000|4242|2026-11-02T17:31:05.0000000Z`,
      `9999|1|2026-11-02T17:00:00.0000000Z`, // no row for the pid at all
    ]) {
      const box = win(table);
      const path = await winRecord();
      const res = await reapOrphan(path, log, { identity: box.identity, isAlive: () => true });
      expect(res.outcome, table).toBe("dead");
      expect(box.pairs).toEqual([]);
      expect(box.taskkills).toEqual([]);
      expect(existsSync(path)).toBe(false);
    }
  });

  it("Windows: only an unreadable table falls back to stopping the verified agent alone (taskkill /F /PID, no /T)", async () => {
    const box = win(null);
    const res = await reapOrphan(await winRecord(), log, {
      identity: box.identity,
      isAlive: () => true,
    });
    expect(res.outcome).toBe("killed");
    expect(box.taskkills).toEqual(["/F /PID 4242"]);
    expect(box.pairs).toEqual([]);
  });

  it("macOS: a record naming the runner's own process group or session is never killed", async () => {
    for (const groups of [
      { self: "4242 0xself", leader: "0xagent" }, // the runner's own group
      { self: "777 0xsame", leader: "0xsame" }, // the runner's session
    ]) {
      const path = await write(rec());
      const killed: number[] = [];
      const res = await reapOrphan(path, log, {
        identity: mac(STARTED, 1, BOOT, groups),
        kill: async (r) => (killed.push(r.pgid), "killed"),
        isAlive: () => true,
      });
      expect(res.outcome, JSON.stringify(groups)).toBe("skipped");
      expect(killed).toEqual([]);
    }
  });

  it("macOS: when ps cannot say whose group it is, nothing is killed and the record stays", async () => {
    const path = await write(rec());
    const base = mac(STARTED);
    const killed: number[] = [];
    const res = await reapOrphan(path, log, {
      identity: {
        ...base,
        run: (cmd: string, args: string[]) =>
          cmd === "ps" && args.includes("sess=") ? null : base.run(cmd, args),
      },
      kill: async (r) => (killed.push(r.pgid), "killed"),
      isAlive: () => true,
    });
    expect(res).toMatchObject({ outcome: "skipped", maybeRunning: true });
    expect(killed).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it("a failed probe of a pid that is still alive keeps the record (unknown), and of a dead pid drops it", async () => {
    const failing = {
      platform: "darwin" as const,
      run: (cmd: string) => (cmd === "sysctl" ? BOOT : null), // `ps` fails
    };
    const path = await write(rec());
    const killed: number[] = [];
    const kill = async (r: PidRecord) => (killed.push(r.pgid), "killed" as const);
    const alive = await reapOrphan(path, log, { identity: failing, kill, isAlive: () => true });
    expect(alive).toMatchObject({ outcome: "skipped", maybeRunning: true });
    expect(existsSync(path)).toBe(true);
    const dead = await reapOrphan(path, log, { identity: failing, kill, isAlive: () => false });
    expect(dead.outcome).toBe("dead");
    expect(killed).toEqual([]);
  });

  it("Windows: a wmic probe against an ISO record keeps the pid file and kills nothing", async () => {
    const calls: string[] = [];
    const identity = {
      platform: "win32" as const,
      run: (cmd: string, args: string[]) => {
        calls.push(cmd);
        const text = [cmd, ...args].join(" ");
        if (cmd === "powershell" && text.includes("LastBootUpTime")) {
          return "2024-11-01T08:00:00.0000000Z";
        }
        if (cmd === "wmic") {
          return "CreationDate=20261102173007.123456+000\r\nParentProcessId=1\r\n";
        }
        return null;
      },
    };
    const path = await winRecord();
    const res = await reapOrphan(path, log, { identity, isAlive: () => true });
    expect(res).toMatchObject({ outcome: "skipped", maybeRunning: true });
    expect(existsSync(path)).toBe(true);
    expect(calls).not.toContain("taskkill");
    expect(logs.join("\n")).toMatch(/cannot be verified/);
    expect(logs.join("\n")).toMatch(/not killing/);
  });

  it("Windows: a process table emptied by dropped non-ISO rows is unverifiable, not gone", async () => {
    const box = win("4242|1|20261102173007.123456+000\r\n5000|4242|20261102173009.000000+000");
    const path = await winRecord();
    const res = await reapOrphan(path, log, { identity: box.identity, isAlive: () => true });
    expect(res).toMatchObject({ outcome: "skipped", maybeRunning: true });
    expect(box.taskkills).toEqual([]);
    expect(box.pairs).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(logs.join("\n")).toMatch(/cannot be verified/);
  });

  it("Windows: an empty table that dropped nothing still means the agent is gone", async () => {
    const box = win("");
    const path = await winRecord();
    const res = await reapOrphan(path, log, { identity: box.identity, isAlive: () => true });
    expect(res.outcome).toBe("dead");
    expect(box.taskkills).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it("Windows: a different ISO creation time is still gone when another row was not ISO", async () => {
    const box = win(
      ["4242|1|2026-11-02T17:31:00.0000000Z", "5000|1|20261102173007.123456+000"].join("\n"),
    );
    const path = await winRecord();
    const res = await reapOrphan(path, log, { identity: box.identity, isAlive: () => true });
    expect(res.outcome).toBe("dead");
    expect(box.taskkills).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it("Windows: a different creation time is another process and gets no taskkill", async () => {
    const calls: string[] = [];
    const identity = {
      platform: "win32" as const,
      run: (cmd: string, args: string[]) => {
        calls.push(cmd);
        if (cmd === "powershell" && args.join(" ").includes("LastBootUpTime")) {
          return "2024-11-01T08:00:00.0000000Z";
        }
        return cmd === "powershell" ? "2026-11-02T19:00:00.0000000Z|1" : null;
      },
    };
    const bootSec = Math.floor(Date.parse("2024-11-01T08:00:00Z") / 1000);
    const path = await write(
      rec({ bootId: `boottime:${bootSec}`, startTime: "2026-11-02T17:30:07.1234560Z" }),
    );
    const res = await reapOrphan(path, log, { identity, isAlive: () => true });
    expect(res.outcome).toBe("dead");
    expect(calls).not.toContain("taskkill");
  });

  it("writePidFile records the start time off Linux through the same probe", async () => {
    const path = join(dir, "pidw");
    await writePidFile(path, { pgid: 4242, command: "claude" }, mac(STARTED));
    expect(await readPidFile(path)).toMatchObject({
      pgid: 4242,
      bootId: "boottime:1730000000",
      startTicks: null,
      startTime: STARTED,
    });
  });
});
