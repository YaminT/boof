import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execCommand, killWindowsProcessTree, MAX_ARG_STRLEN } from "./process.js";

describe("execCommand", () => {
  it("refuses an argument over MAX_ARG_STRLEN with a clear error instead of E2BIG", async () => {
    const res = await execCommand("true", ["ok", "x".repeat(MAX_ARG_STRLEN)], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(res.code).toBeNull();
    expect(res.stderr).toBe(
      `argument 2 is ${MAX_ARG_STRLEN} bytes, over the ${MAX_ARG_STRLEN}-byte limit of one argument (E2BIG)`,
    );
    expect(
      (await execCommand("true", ["x".repeat(MAX_ARG_STRLEN - 1)], { cwd: process.cwd() })).code,
    ).toBe(0);
  });

  it("survives a child that exits before reading its stdin (no uncaught EPIPE)", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      // 8 MB is far more than a pipe buffer, so the write is still pending when
      // `true` exits; before the fix this raised an uncaught EPIPE.
      const res = await execCommand("true", [], {
        cwd: process.cwd(),
        input: "x".repeat(8 * 1024 * 1024),
        timeoutMs: 10000,
      });
      expect(res.code).toBe(0);
      await new Promise((r) => setTimeout(r, 100));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("a steer signal kills the whole process group and reports steered, not stopped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boof-exec-steer-"));
    try {
      const steer = join(dir, "steer");
      // The shell prints the pid of a background grandchild, then waits on it.
      let out = "";
      const running = execCommand("sh", ["-c", "sleep 60 & echo $!; wait"], {
        cwd: dir,
        steerSignalPath: steer,
        stopPollMs: 20,
        onData: (c) => (out += c),
      });
      await new Promise((r) => setTimeout(r, 300));
      await writeFile(steer, "x\n");
      const res = await running;
      expect(res.steered).toBe(true);
      expect(res.stopped).toBe(false);
      expect(res.timedOut).toBe(false);
      const grandchild = Number(out.trim());
      expect(grandchild).toBeGreaterThan(1);
      // The grandchild dies with the group (allow the SIGKILL grace).
      for (let i = 0; i < 40 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive(grandchild)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a stop signal wins over a steer signal, and neither is set when none appears", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boof-exec-steer-"));
    try {
      const stop = join(dir, "stop");
      const steer = join(dir, "steer");
      await writeFile(stop, "x\n");
      await writeFile(steer, "x\n");
      const both = await execCommand("sleep", ["60"], {
        cwd: dir,
        stopSignalPath: stop,
        steerSignalPath: steer,
        stopPollMs: 20,
      });
      expect(both.stopped).toBe(true);
      expect(both.steered).toBe(false);
      const none = await execCommand("true", [], { cwd: dir, steerSignalPath: steer + "-x" });
      expect(none.steered).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes control/pid with the child's process group while it runs and removes it on close", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boof-exec-pid-"));
    try {
      const pidFilePath = join(dir, "control", "pid");
      const stop = join(dir, "control", "stop");
      const running = execCommand(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
        cwd: dir,
        pidFilePath,
        stopSignalPath: stop,
        stopPollMs: 20,
        timeoutMs: 15_000,
      });
      while (!existsSync(pidFilePath)) await new Promise((r) => setImmediate(r));
      const rec = JSON.parse(await readFile(pidFilePath, "utf8"));
      expect(rec).toMatchObject({ command: "node" });
      expect(rec.pgid).toBeGreaterThan(0);
      expect(() => process.kill(rec.pgid, 0)).not.toThrow();
      await writeFile(stop, "test\n");
      const res = await running;
      expect(res.stopped).toBe(true);
      expect(existsSync(pidFilePath)).toBe(false);
      // A child that finishes on its own leaves no file either.
      await execCommand("true", [], { cwd: dir, pidFilePath });
      expect(existsSync(pidFilePath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  /**
   * A child that never really starts. `close` after `fallbackMs` keeps a missed kill from hanging.
   * `hold: true` leaves it running so the 1.5s follow-up kill can fire; `kill` then does not set
   * `signalCode` (a real handle kill does not, until the process actually exits).
   */
  const fakeChild = (pid = 4242, fallbackMs = 200, hold = false) => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: EventEmitter & { write: () => boolean; end: () => void };
      kill: ReturnType<typeof vi.fn>;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child.pid = pid;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const stdin = new EventEmitter() as typeof child.stdin;
    stdin.write = () => true;
    stdin.end = () => {};
    child.stdin = stdin;
    child.kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      if (!hold) {
        child.signalCode = signal;
        setTimeout(() => child.emit("close", null, signal), 0);
      }
      return true;
    });
    if (!hold) {
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.emit("close", 1, null);
      }, fallbackMs);
    }
    return child;
  };

  const ROOT = "2026-11-02T17:30:07.1234560Z";
  const CHILD = "2026-11-02T17:30:09.0000000Z";
  const GRAND = "2026-11-02T17:30:10.0000000Z";
  const OLD = "2026-11-02T08:00:00.0000000Z";
  const windowsTable = {
    rows: [
      { pid: 4242, ppid: 1, created: ROOT },
      { pid: 5000, ppid: 4242, created: CHILD },
      { pid: 5001, ppid: 5000, created: GRAND },
      // Started before the agent, still listing its pid as parent. Not ours, nor its child.
      { pid: 6000, ppid: 4242, created: OLD },
      { pid: 6001, ppid: 6000, created: "2026-11-02T09:00:00.0000000Z" },
      // Same instant as the agent: not provably after.
      { pid: 6002, ppid: 4242, created: ROOT },
    ],
    droppedNonIso: 0,
    unparsed: 0,
  };

  it("spawns with windowsHide so a GUI parent does not open a console", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const res = await execCommand(
      "git",
      ["status"],
      { cwd: process.cwd(), timeoutMs: 1000 },
      { spawn },
    );
    expect(res.code).toBe(1);
    expect(spawn).toHaveBeenCalledWith(
      "git",
      ["status"],
      expect.objectContaining({
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  });

  it("on Windows a stop kills verified children and the root handle, never taskkill /T", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const killed: { pid: number }[][] = [];
    const table = vi.fn(async () => windowsTable);
    const dir = await mkdtemp(join(tmpdir(), "boof-exec-win-"));
    const stop = join(dir, "stop");
    try {
      await writeFile(stop, "x\n");
      const res = await execCommand(
        "git",
        ["status"],
        { cwd: dir, stopSignalPath: stop, stopPollMs: 10, timeoutMs: 1000 },
        {
          platform: "win32",
          spawn,
          windowsKill: {
            table,
            killList: async (list) => {
              killed.push(list);
              return true;
            },
          },
        },
      );
      expect(res.stopped).toBe(true);
      expect(spawn).toHaveBeenCalledWith(
        "git",
        ["status"],
        expect.objectContaining({ windowsHide: true, detached: false }),
      );
      expect(table).toHaveBeenCalledTimes(1);
      // Deepest first. The root is not in this list: it dies through the handle. Strangers are absent.
      expect(killed).toEqual([
        [
          { pid: 5001, created: GRAND },
          { pid: 5000, created: CHILD },
        ],
      ]);
      expect(JSON.stringify(killed)).not.toMatch(/6000|6001|6002|4242/);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("on Windows a process table that cannot be read kills only the root handle", async () => {
    // The old test threw "taskkill missing". spawnSync does not throw when the binary is absent;
    // it returns { status: null }. That failure is a null table here (see runProbeAsync).
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const killList = vi.fn(async () => true);
    const dir = await mkdtemp(join(tmpdir(), "boof-exec-win-"));
    const stop = join(dir, "stop");
    try {
      await writeFile(stop, "x\n");
      const res = await execCommand(
        "git",
        ["status"],
        { cwd: dir, stopSignalPath: stop, stopPollMs: 10, timeoutMs: 1000 },
        {
          platform: "win32",
          spawn,
          windowsKill: { table: async () => null, killList },
        },
      );
      expect(res.stopped).toBe(true);
      expect(killList).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("on Windows the follow-up kill uses the handle once and does not walk the tree again", async () => {
    const child = fakeChild(4242, 0, true);
    const spawn = vi.fn(() => child);
    const table = vi.fn(async () => windowsTable);
    const killList = vi.fn(async () => true);
    const dir = await mkdtemp(join(tmpdir(), "boof-exec-win-"));
    const stop = join(dir, "stop");
    let closed = false;
    const closeChild = () => {
      if (closed) return;
      closed = true;
      child.signalCode = "SIGKILL";
      child.emit("close", null, "SIGKILL");
    };
    try {
      await writeFile(stop, "x\n");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const running = execCommand(
        "git",
        ["status"],
        { cwd: dir, stopSignalPath: stop, stopPollMs: 500, timeoutMs: 10_000 },
        { platform: "win32", spawn, windowsKill: { table, killList } },
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(table).toHaveBeenCalledTimes(1);
      expect(killList).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      // Still running: signalCode is unset, so the 1.5s follow-up is a second handle kill, not a
      // second pid walk. The first kill did not close the child, so the timer was not cleared.
      await vi.advanceTimersByTimeAsync(1500);
      expect(table).toHaveBeenCalledTimes(1);
      expect(killList).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledTimes(2);
      expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
      closeChild();
      await expect(running).resolves.toMatchObject({ stopped: true });
      // Exited: another poll must not kill by the pid, nor touch the handle again.
      await vi.advanceTimersByTimeAsync(2000);
      expect(table).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledTimes(2);
    } finally {
      closeChild();
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("on Windows a follow-up that fires while the table is pending does not kill the root first", async () => {
    const child = fakeChild(4242, 0, true);
    const spawn = vi.fn(() => child);
    const seen: string[] = [];
    let releaseTable: () => void = () => {};
    const table = vi.fn(
      () =>
        new Promise<typeof windowsTable>((resolve) => {
          releaseTable = () => {
            const killed = child.kill.mock.calls.length > 0;
            seen.push(killed ? "table-after-kill" : "table-before-kill");
            // TerminateProcess removes the root. A table read after the handle kill
            // has no root row, and then no child can be found.
            resolve({
              rows: killed
                ? windowsTable.rows.filter((row) => row.pid !== 4242)
                : windowsTable.rows,
              droppedNonIso: 0,
              unparsed: 0,
            });
          };
        }),
    );
    const killed: { pid: number; created: string }[][] = [];
    const killList = vi.fn(async (list: { pid: number; created: string }[]) => {
      seen.push("children");
      killed.push(list);
      return true;
    });
    child.kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      seen.push(`kill:${signal}`);
      return true;
    });
    const dir = await mkdtemp(join(tmpdir(), "boof-exec-win-"));
    const stop = join(dir, "stop");
    const closeChild = () => {
      if (child.signalCode !== null) return;
      child.signalCode = "SIGKILL";
      child.emit("close", null, "SIGKILL");
    };
    try {
      await writeFile(stop, "x\n");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const running = execCommand(
        "git",
        ["status"],
        { cwd: dir, stopSignalPath: stop, stopPollMs: 500, timeoutMs: 60_000 },
        { platform: "win32", spawn, windowsKill: { table, killList } },
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(table).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalled();
      // The 1.5s SIGKILL lands while the snapshot is still in flight. It must wait.
      await vi.advanceTimersByTimeAsync(1500);
      expect(child.kill).not.toHaveBeenCalled();
      expect(killList).not.toHaveBeenCalled();
      releaseTable();
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual(["table-before-kill", "kill:SIGTERM", "children", "kill:SIGKILL"]);
      expect(killed).toEqual([
        [
          { pid: 5001, created: GRAND },
          { pid: 5000, created: CHILD },
        ],
      ]);
      expect(JSON.stringify(killed)).not.toMatch(/6000|6001|6002|4242/);
      closeChild();
      await expect(running).resolves.toMatchObject({ stopped: true });
    } finally {
      closeChild();
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("on Windows a stranger that reused the root pid after exit is not killed", async () => {
    const child = fakeChild(4242, 0, true);
    const spawn = vi.fn(() => child);
    let releaseTable: (table: typeof windowsTable) => void = () => {};
    const table = vi.fn(
      () =>
        new Promise<typeof windowsTable>((resolve) => {
          releaseTable = resolve;
        }),
    );
    const killList = vi.fn(async () => true);
    const dir = await mkdtemp(join(tmpdir(), "boof-exec-win-"));
    const stop = join(dir, "stop");
    const closeChild = () => {
      if (child.listenerCount("close") === 0) return;
      child.emit("close", 0, null);
    };
    try {
      await writeFile(stop, "x\n");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const running = execCommand(
        "git",
        ["status"],
        { cwd: dir, stopSignalPath: stop, stopPollMs: 500, timeoutMs: 60_000 },
        { platform: "win32", spawn, windowsKill: { table, killList } },
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(table).toHaveBeenCalledTimes(1);
      // The root has exited and Node has closed the handle. The pid may be someone else's.
      child.exitCode = 0;
      releaseTable({
        rows: [
          { pid: 4242, ppid: 1, created: "2026-11-02T18:00:00.0000000Z" },
          { pid: 7000, ppid: 4242, created: "2026-11-02T18:00:01.0000000Z" },
        ],
        droppedNonIso: 0,
        unparsed: 0,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(killList).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
      closeChild();
      await expect(running).resolves.toMatchObject({ stopped: true });
    } finally {
      closeChild();
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("on Windows a hung process table still lets the timeout stop the root", async () => {
    const child = fakeChild(4242, 0, true);
    child.kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      child.signalCode = signal;
      child.emit("close", null, signal);
      return true;
    });
    const spawn = vi.fn(() => child);
    const table = vi.fn(() => new Promise<typeof windowsTable>(() => {}));
    const killList = vi.fn(async () => true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const running = execCommand(
        "git",
        ["status"],
        { cwd: process.cwd(), timeoutMs: 1_000 },
        { platform: "win32", spawn, windowsKill: { table, killList } },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(table).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalled();
      // The probe bound (same 5s as runProbeAsync). Past it, the deadline's kill
      // has stopped the root even though the table never resolved.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(killList).not.toHaveBeenCalled();
      await expect(running).resolves.toMatchObject({ timedOut: true });
    } finally {
      if (child.signalCode === null) {
        child.signalCode = "SIGKILL";
        child.emit("close", null, "SIGKILL");
      }
      vi.useRealTimers();
    }
  });
});

describe("killWindowsProcessTree", () => {
  const ROOT = "2026-11-02T17:30:07.1234560Z";
  const CHILD = "2026-11-02T17:30:09.0000000Z";
  const OLD = "2026-11-02T08:00:00.0000000Z";

  it("kills children created after the root, then the root handle, and never the root by pid", async () => {
    const killed: { pid: number; created: string }[] = [];
    const roots: string[] = [];
    await killWindowsProcessTree(4242, () => roots.push("root"), {
      table: async () => ({
        rows: [
          { pid: 4242, ppid: 1, created: ROOT },
          { pid: 5000, ppid: 4242, created: CHILD },
          { pid: 6000, ppid: 4242, created: OLD },
        ],
        droppedNonIso: 0,
        unparsed: 0,
      }),
      killList: async (list) => {
        killed.push(...list);
        return true;
      },
    });
    expect(killed).toEqual([{ pid: 5000, created: CHILD }]);
    expect(roots).toEqual(["root"]);
  });

  it("still kills the root handle when the table cannot be read", async () => {
    const roots: string[] = [];
    const killList = vi.fn(async () => true);
    await killWindowsProcessTree(4242, () => roots.push("root"), {
      table: async () => null,
      killList,
    });
    expect(roots).toEqual(["root"]);
    expect(killList).not.toHaveBeenCalled();
  });

  it("kills the root handle when the table query throws", async () => {
    const roots: string[] = [];
    await killWindowsProcessTree(4242, () => roots.push("root"), {
      table: async () => {
        throw new Error("probe down");
      },
    });
    expect(roots).toEqual(["root"]);
  });

  it("does not kill a stranger that reused the root pid after the child exited", async () => {
    const killList = vi.fn(async () => true);
    const roots: string[] = [];
    await killWindowsProcessTree(4242, () => roots.push("root"), {
      table: async () => ({
        rows: [
          { pid: 4242, ppid: 1, created: "2026-11-02T18:00:00.0000000Z" },
          { pid: 7000, ppid: 4242, created: CHILD },
        ],
        droppedNonIso: 0,
        unparsed: 0,
      }),
      killList,
      rootStillOurs: () => false,
    });
    expect(killList).not.toHaveBeenCalled();
    expect(roots).toEqual(["root"]);
  });
});
