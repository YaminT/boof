import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentBootId,
  isAlive,
  killGroup,
  readPidFile,
  reapOrphan,
  writePidFile,
} from "./pid-file.js";

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
    expect(rec).toMatchObject({ pgid: 4242, command: "claude", bootId: currentBootId() });
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

  it.skipIf(!currentBootId())(
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
