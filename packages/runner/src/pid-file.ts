import { readFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite } from "@boof-runner/shared";

export interface PidRecord {
  pgid: number;
  command: string;
  startedAt: string;
  bootId: string | null;
  /** Field 22 of /proc/<pgid>/stat (clock ticks since boot) when written; null off Linux. */
  startTicks: number | null;
  /** Pid of the runner process that spawned the group; null when unknown. */
  ownerPid: number | null;
}

interface ProcStat {
  ppid: number;
  pgrp: number;
  sid: number;
  startTicks: number;
}

/** Linux only: parse /proc/<pid>/stat after the last ")" (the command may contain anything). */
function readProcStat(pid: number | "self"): ProcStat | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const r = {
      ppid: Number(f[1]),
      pgrp: Number(f[2]),
      sid: Number(f[3]),
      startTicks: Number(f[19]),
    };
    return Object.values(r).every(Number.isFinite) ? r : undefined;
  } catch {
    return undefined;
  }
}

let bootIdCache: string | null | undefined;

/** Linux boot id, read once; `null` on any error or off Linux. */
export function currentBootId(): string | null {
  if (bootIdCache === undefined) {
    try {
      bootIdCache = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    } catch {
      bootIdCache = null;
    }
  }
  return bootIdCache;
}

export async function writePidFile(
  path: string,
  rec: {
    pgid: number;
    command: string;
    bootId?: string | null;
    startTicks?: number | null;
    ownerPid?: number | null;
  },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(
    path,
    JSON.stringify({
      pgid: rec.pgid,
      command: rec.command,
      startedAt: new Date().toISOString(),
      bootId: rec.bootId === undefined ? currentBootId() : rec.bootId,
      startTicks:
        rec.startTicks === undefined
          ? (readProcStat(rec.pgid)?.startTicks ?? null)
          : rec.startTicks,
      ownerPid: rec.ownerPid === undefined ? process.pid : rec.ownerPid,
    }),
  );
}

export async function readPidFile(path: string): Promise<PidRecord | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<PidRecord>;
    if (!Number.isInteger(raw.pgid) || (raw.pgid as number) <= 0) return undefined;
    return {
      pgid: raw.pgid as number,
      command: typeof raw.command === "string" ? raw.command : "",
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
      bootId: typeof raw.bootId === "string" ? raw.bootId : null,
      startTicks: Number.isInteger(raw.startTicks) ? (raw.startTicks as number) : null,
      ownerPid: Number.isInteger(raw.ownerPid) ? (raw.ownerPid as number) : null,
    };
  } catch {
    return undefined;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True while any member of the group exists (EPERM: exists, not ours to signal). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Never signal init, the kernel, or the runner's own process, parent, group or session. */
function isSignalable(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid || pgid === process.ppid) {
    return false;
  }
  const self = readProcStat("self");
  return !self || (pgid !== self.pgrp && pgid !== self.sid);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitGone(pgid: number, ms: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
  return true;
}

export async function killGroup(
  pgid: number,
  opts: { termWaitMs?: number; killWaitMs?: number; pollMs?: number } = {},
): Promise<"exited" | "killed" | "survived"> {
  if (!isSignalable(pgid)) return "survived";
  const pollMs = opts.pollMs ?? 50;
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-pgid, s);
    } catch {
      /* gone, or not ours */
    }
  };
  signal("SIGTERM");
  if (await waitGone(pgid, opts.termWaitMs ?? 2000, pollMs)) return "exited";
  signal("SIGKILL");
  return (await waitGone(pgid, opts.killWaitMs ?? 1000, pollMs)) ? "killed" : "survived";
}

/**
 * Kill the process group a crashed runner recorded. Kills only when the boot id is known and
 * equal, the group is not the runner's own, its leader's start time equals the recorded one
 * exactly (a reused or forged pid differs), and the recording runner is not still its parent.
 * Records without a start time (older versions) are never killed. The command line is not
 * compared: shebang wrappers and exec chains change it. Skipped records are removed, except one
 * whose owner is alive. Off Linux nothing is killed: a live process is reported as
 * `maybeRunning` and its record is left in place (it goes with the task's working area when the
 * task fails); a dead one is removed.
 */
export async function reapOrphan(
  path: string,
  log: (line: string) => void,
): Promise<{
  outcome: "none" | "dead" | "killed" | "skipped";
  record?: PidRecord;
  /** Off Linux only: the recorded process is still alive and was not killed; its record is left in place. */
  maybeRunning?: boolean;
}> {
  const record = await readPidFile(path);
  if (!record) return { outcome: "none" };
  const finish = async (outcome: "dead" | "killed" | "skipped", remove = true) => {
    if (remove) await rm(path, { force: true }).catch(() => {});
    return { outcome, record };
  };
  if (process.platform !== "linux") {
    // Reaping needs /proc (boot id and exact start time), so nothing is killed here. A process
    // that is still alive is reported rather than silently forgotten; its record stays until the
    // task's working area is removed.
    const alive = process.platform === "win32" ? isAlive(record.pgid) : groupAlive(record.pgid);
    if (!alive) return finish("dead");
    log(
      `orphan reaping is not supported on ${process.platform}; agent process ${record.pgid} (${record.command}) may still be running; not killing`,
    );
    return { outcome: "skipped", record, maybeRunning: true };
  }
  const skip = (why: string, remove = true) => {
    log(`${why} (${record.pgid}); not killing`);
    return finish("skipped", remove);
  };
  const boot = currentBootId();
  if (!boot || !record.bootId) return skip("boot id cannot be determined");
  if (record.bootId !== boot) return skip("pid file is from another boot");
  if (!isSignalable(record.pgid)) return skip("refusing to signal this process group");
  if (!groupAlive(record.pgid)) return finish("dead");
  if (record.startTicks === null) return skip("pid file has no process start time");
  const leader = readProcStat(record.pgid);
  if (!leader || leader.pgrp !== record.pgid || leader.startTicks !== record.startTicks) {
    return skip("process is not the recorded agent group leader (pid reused?)");
  }
  if (record.ownerPid && isAlive(record.ownerPid) && leader.ppid === record.ownerPid) {
    return skip(`recording runner ${record.ownerPid} is still running`, false);
  }
  const result = await killGroup(record.pgid);
  if (result === "survived") {
    log(`could not kill orphaned agent process group ${record.pgid} (${record.command}): survived`);
    return finish("skipped");
  }
  log(`killed orphaned agent process group ${record.pgid} (${record.command}): ${result}`);
  return finish("killed");
}
