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

  it.skipIf(!currentBootId())(
    "reapOrphan: none / dead / killed / another boot / not a group leader",
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
      await writePidFile(path, { pgid: live.pid!, command: "node" });
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

      // A live process that is not a group leader (a plain child of this runner shares its
      // group) is never killed, even with a matching boot id.
      const member = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
        stdio: "ignore",
      });
      try {
        await writePidFile(path, { pgid: member.pid!, command: "node" });
        expect((await reapOrphan(path, (l) => log.push(l))).outcome).toBe("skipped");
        expect(isAlive(member.pid!)).toBe(true);
      } finally {
        member.kill("SIGKILL");
      }

      // A record written before the process started (a reused pid) is never killed.
      const late = sleeper();
      await writePidFile(path, { pgid: late.pid!, command: "node" });
      const rec = JSON.parse(await readFile(path, "utf8"));
      rec.startedAt = new Date(Date.now() - 3_600_000).toISOString();
      await writeFile(path, JSON.stringify(rec));
      expect((await reapOrphan(path, (l) => log.push(l))).outcome).toBe("skipped");
      expect(isAlive(late.pid!)).toBe(true);
    },
  );
});
