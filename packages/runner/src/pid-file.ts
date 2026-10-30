import { readFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite } from "@boof-runner/shared";

export interface PidRecord {
  pgid: number;
  command: string;
  startedAt: string;
  bootId: string | null;
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
  rec: { pgid: number; command: string; bootId?: string | null },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(
    path,
    JSON.stringify({
      pgid: rec.pgid,
      command: rec.command,
      startedAt: new Date().toISOString(),
      bootId: rec.bootId === undefined ? currentBootId() : rec.bootId,
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

/** Never signal init, the kernel, or the runner's own process/group. */
function isSignalable(pgid: number): boolean {
  return Number.isInteger(pgid) && pgid > 1 && pgid !== process.pid && pgid !== process.ppid;
}

/**
 * Linux only: true when `pid` is the leader of its own process group and started no later than
 * the pid file was written (a reused pid would have started after). `false` when unverifiable.
 */
function isRecordedLeader(pid: number, startedAt: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const pgrp = Number(f[2]);
    const startTicks = Number(f[19]);
    if (pgrp !== pid || !Number.isFinite(startTicks)) return false;
    const btime = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
    const written = Date.parse(startedAt);
    if (!btime || Number.isNaN(written)) return false;
    const procStart = (Number(btime[1]) + startTicks / 100) * 1000;
    return procStart <= written + 2000;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitGone(pid: number, ms: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isAlive(pid)) {
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
 * equal to the recorded one, and `pgid` is still a group leader that started before the record
 * was written; anything else (other boot, unknown boot id, reused or foreign pid) is skipped.
 */
export async function reapOrphan(
  path: string,
  log: (line: string) => void,
): Promise<{ outcome: "none" | "dead" | "killed" | "skipped"; record?: PidRecord }> {
  const record = await readPidFile(path);
  if (!record) return { outcome: "none" };
  const finish = async (outcome: "dead" | "killed" | "skipped") => {
    await rm(path, { force: true }).catch(() => {});
    return { outcome, record };
  };
  const boot = currentBootId();
  if (!boot || !record.bootId) {
    log(`boot id cannot be determined (${record.pgid}); not killing`);
    return finish("skipped");
  }
  if (record.bootId !== boot) {
    log(`pid file is from another boot (${record.pgid}); not killing`);
    return finish("skipped");
  }
  if (!isSignalable(record.pgid)) {
    log(`refusing to signal process group ${record.pgid}`);
    return finish("skipped");
  }
  if (!isAlive(record.pgid)) return finish("dead");
  if (!isRecordedLeader(record.pgid, record.startedAt)) {
    log(`process ${record.pgid} is not the recorded agent group leader (pid reused?); not killing`);
    return finish("skipped");
  }
  const result = await killGroup(record.pgid);
  log(`killed orphaned agent process group ${record.pgid} (${record.command}): ${result}`);
  return finish(result === "survived" ? "skipped" : "killed");
}
