import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite } from "./atomic.js";
import {
  agentStatus,
  bootIdentity,
  probeProcess,
  processTable,
  runProbe,
  readProcStat,
  sharesRunnerGroup,
  verifiedDescendants,
  killVerified,
  windowsTimeKind,
  type IdentityDeps,
} from "./process-identity.js";

export interface PidRecord {
  pgid: number;
  command: string;
  startedAt: string;
  bootId: string | null;
  /** Field 22 of /proc/<pgid>/stat (clock ticks since boot) when written; null off Linux. */
  startTicks: number | null;
  /** macOS: `ps` lstart; Windows: the CIM creation time; null on Linux and when unreadable. */
  startTime: string | null;
  /** Pid of the runner process that spawned the group; null when unknown. */
  ownerPid: number | null;
}

/** The current boot (Linux boot id, or `boottime:<sec>` on macOS and Windows); null on any error. */
export function currentBootIdentity(): string | null {
  return bootIdentity();
}

export async function writePidFile(
  path: string,
  rec: {
    pgid: number;
    command: string;
    bootId?: string | null;
    startTicks?: number | null;
    startTime?: string | null;
    ownerPid?: number | null;
  },
  identity?: IdentityDeps,
): Promise<void> {
  const probe =
    rec.startTicks === undefined || rec.startTime === undefined
      ? probeProcess(rec.pgid, identity)
      : undefined;
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(
    path,
    JSON.stringify({
      pgid: rec.pgid,
      command: rec.command,
      startedAt: new Date().toISOString(),
      bootId: rec.bootId === undefined ? bootIdentity(identity) : rec.bootId,
      startTicks: rec.startTicks === undefined ? (probe?.startTicks ?? null) : rec.startTicks,
      startTime: rec.startTime === undefined ? (probe?.startTime ?? null) : rec.startTime,
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
      startTime: typeof raw.startTime === "string" ? raw.startTime : null,
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
  const self = process.platform === "linux" ? readProcStat("self") : undefined;
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
export interface ReapDeps {
  /** Platform and probe commands (tests mock them). */
  identity?: IdentityDeps;
  /** Stop the recorded agent (default: the process group on POSIX, a verified tree walk with `taskkill /F /PID` on Windows). */
  kill?: (record: PidRecord) => Promise<"exited" | "killed" | "survived">;
  isAlive?: (pid: number) => boolean;
}

export interface ReapResult {
  outcome: "none" | "dead" | "killed" | "skipped";
  record?: PidRecord;
  /** Off Linux: the recorded process is alive but could not be verified as the agent, so it was not killed; its record stays. */
  maybeRunning?: boolean;
  /** The recorded agent was verified and is still running (it survived, or its runner still owns it); its record stays. */
  stillRunning?: boolean;
}

/**
 * Windows has no process groups. The agent was verified by its creation time (the `-Filter`
 * probe); its children are found by walking ONE process-table query downward, taking only
 * processes created after their parent (Windows does not reparent orphans, so a stranger may list
 * a reused pid as its parent). Never `taskkill /T`, which follows parent ids blindly.
 *
 * The table is a second look, a moment later. If it is readable and does not show the agent with
 * the recorded creation time, the agent has gone (its pid may already belong to someone else):
 * nothing is killed (`"gone"`). That is not the case when the two times are different spellings
 * (`wmic` against ISO): they cannot be compared, so the result is `"unverifiable"` and the record
 * stays. The same when the listing dropped rows or returned lines that were not `pid|ppid|time` —
 * the agent's own row may be one of those. A truly empty listing (nothing dropped, nothing
 * unparsed) is `"gone"`. Only an unreadable table (the query failed) falls back to stopping the
 * verified agent alone with `taskkill /F /PID`. Otherwise the agent and its children are stopped
 * deepest first by {@link killVerified}: one PowerShell process that opens each process and
 * compares its start time before it kills, so the pid cannot be reused between the check and the
 * kill. After the kill, `"unknown"` (a probe that can no longer be compared) is `"unverifiable"`,
 * not `"killed"`. A Job Object (kill on close) at spawn is the long-term fix; see
 * goals/desktop-orphan-reaping-macos-windows.
 */
async function killTree(
  record: PidRecord,
  identity: IdentityDeps,
): Promise<"exited" | "killed" | "survived" | "gone" | "unverifiable"> {
  const run = identity.run ?? runProbe;
  const table = processTable(identity);
  if (table === null) {
    run("taskkill", ["/F", "/PID", String(record.pgid)]);
  } else {
    const root = table.rows.find((r) => r.pid === record.pgid);
    if (!root) {
      if (table.droppedNonIso > 0 || table.unparsed > 0) return "unverifiable";
      return "gone";
    }
    // A wmic stamp and an ISO stamp are not two processes. Deleting the record here would let
    // Retry start a second agent in the worktree the first one is still using.
    if (
      typeof record.startTime !== "string" ||
      windowsTimeKind(root.created) !== windowsTimeKind(record.startTime)
    ) {
      return "unverifiable";
    }
    if (root.created !== record.startTime) return "gone";
    const byPid = new Map(table.rows.map((r) => [r.pid, r]));
    const list = [...verifiedDescendants(record.pgid, table.rows), record.pgid].map((pid) => ({
      pid,
      created: byPid.get(pid)!.created,
    }));
    killVerified(list, identity);
  }
  for (let i = 0; i < 20; i += 1) {
    const status = agentStatus(record, identity);
    if (status === "unknown") return "unverifiable";
    if (status !== "running") return "killed";
    await sleep(100);
  }
  return "survived";
}

export async function reapOrphan(
  path: string,
  log: (line: string) => void,
  deps: ReapDeps = {},
): Promise<ReapResult> {
  const record = await readPidFile(path);
  if (!record) return { outcome: "none" };
  const finish = async (outcome: "dead" | "killed" | "skipped", remove = true) => {
    if (remove) await rm(path, { force: true }).catch(() => {});
    return { outcome, record };
  };
  const platform = deps.identity?.platform ?? process.platform;
  if (platform !== "linux") {
    return reapOffLinux(record, log, platform, deps, finish);
  }
  const skip = (why: string, remove = true) => {
    log(`${why} (${record.pgid}); not killing`);
    return finish("skipped", remove);
  };
  const boot = currentBootIdentity();
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
    log(`recording runner ${record.ownerPid} is still running (${record.pgid}); not killing`);
    return { outcome: "skipped", record, stillRunning: true };
  }
  const result = await killGroup(record.pgid);
  if (result === "survived") {
    log(`could not kill orphaned agent process group ${record.pgid} (${record.command}): survived`);
    return { outcome: "skipped", record, stillRunning: true };
  }
  log(`killed orphaned agent process group ${record.pgid} (${record.command}): ${result}`);
  return finish("killed");
}

/**
 * macOS and Windows, with the same rule as Linux: nothing is signalled unless the recorded boot and
 * the exact start time match. A record that cannot be verified is never killed; if its process is
 * still alive it is reported (`maybeRunning`) and its record stays.
 */
async function reapOffLinux(
  record: PidRecord,
  log: (line: string) => void,
  platform: NodeJS.Platform,
  deps: ReapDeps,
  finish: (
    outcome: "dead" | "killed" | "skipped",
    remove?: boolean,
  ) => Promise<{ outcome: "dead" | "killed" | "skipped"; record: PidRecord }>,
): Promise<ReapResult> {
  const alive =
    deps.isAlive ?? ((pid: number) => (platform === "win32" ? isAlive(pid) : groupAlive(pid)));
  const identity: IdentityDeps = { alive, ...deps.identity, platform };
  if (!isSignalable(record.pgid)) {
    log(`refusing to signal this process (${record.pgid}); not killing`);
    return finish("skipped");
  }
  const status = agentStatus(record, identity);
  if (status === "gone") return finish("dead");
  if (status === "unknown") {
    if (!alive(record.pgid)) return finish("dead");
    log(
      `agent process ${record.pgid} (${record.command}) may still be running, but its identity cannot be verified on ${platform}; not killing`,
    );
    return { outcome: "skipped", record, maybeRunning: true };
  }
  // Verified: the recorded boot, pid and start time. Is the recording runner still its parent?
  const probe = probeProcess(record.pgid, identity);
  if (record.ownerPid && alive(record.ownerPid) && probe?.ppid === record.ownerPid) {
    log(`recording runner ${record.ownerPid} is still running (${record.pgid}); not killing`);
    return { outcome: "skipped", record, stillRunning: true };
  }
  // Never the runner's own group or session (a forged or damaged record); if `ps` cannot say, do not kill.
  const own = sharesRunnerGroup(record.pgid, identity);
  if (own === undefined) {
    log(`cannot tell whether process group ${record.pgid} is the runner's own; not killing`);
    return { outcome: "skipped", record, maybeRunning: true };
  }
  if (own) {
    log(`refusing to signal the runner's own process group or session (${record.pgid})`);
    return finish("skipped");
  }
  const result = deps.kill
    ? await deps.kill(record)
    : platform === "win32"
      ? await killTree(record, identity)
      : await killGroup(record.pgid);
  if (result === "unverifiable") {
    if (!alive(record.pgid)) return finish("dead");
    log(
      `agent process ${record.pgid} (${record.command}) may still be running, but its identity cannot be verified on ${platform}; not killing`,
    );
    return { outcome: "skipped", record, maybeRunning: true };
  }
  if (result === "gone") {
    log(
      `agent ${record.pgid} (${record.command}) is gone: its pid shows another process; not killing`,
    );
    return finish("dead");
  }
  if (result === "survived") {
    log(`could not kill orphaned agent ${record.pgid} (${record.command}): survived`);
    return { outcome: "skipped", record, stillRunning: true };
  }
  log(`killed orphaned agent ${record.pgid} (${record.command}): ${result}`);
  return finish("killed");
}
