/**
 * Who a process really is, across platforms: a pid alone is not an identity (pids are reused), so a
 * recorded agent is the process with that pid whose start time equals the recorded one, in the same
 * boot. Linux reads /proc (boot id, start ticks); macOS asks `sysctl` and `ps`; Windows asks
 * PowerShell CIM, with `wmic` as a fallback. The platform and the commands are injected so the
 * platform code can be tested without the platform. The macOS and Windows branches have been checked
 * only against mocked command output.
 *
 * Nothing here signals a process. Callers that kill (the runner's orphan reaper) or refuse (Retry
 * while a recorded agent is alive) decide with `agentStatus`, and treat "unknown" as "do not act".
 * On Windows a start time that came back in another form (PowerShell ISO against `wmic`, or a
 * probe that had to fall back) is "unknown": the strings differ even when the process is the same.
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export interface IdentityDeps {
  platform?: NodeJS.Platform;
  /** Run a command and return its stdout, or null on any failure or timeout. `input` goes to its stdin. */
  run?: (cmd: string, args: string[], opts?: { input?: string }) => string | null;
  /** Read a file as text, or null. */
  readFile?: (path: string) => string | null;
  /** Does a process with this pid exist (signal 0)? Tests inject it for made-up pids. */
  alive?: (pid: number) => boolean;
}

const defaultAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The environment the probe commands run in: `ps` prints dates in the user's language otherwise. */
export const probeEnv = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
  ...base,
  LC_ALL: "C",
  LANG: "C",
});

/** Run a probe command: stdout, or null on any failure or timeout. */
export const runProbe = (
  cmd: string,
  args: string[],
  opts: { input?: string } = {},
): string | null => {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "ignore"],
      env: probeEnv(),
    });
  } catch {
    return null;
  }
};
const defaultRead = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const resolveDeps = (d: IdentityDeps = {}) => ({
  platform: d.platform ?? process.platform,
  run: d.run ?? runProbe,
  readFile: d.readFile ?? defaultRead,
  alive: d.alive ?? defaultAlive,
});

export interface ProcStat {
  ppid: number;
  pgrp: number;
  sid: number;
  startTicks: number;
}

/** Linux only: parse /proc/<pid>/stat after the last ")" (the command may contain anything). */
export function readProcStat(pid: number | "self", d: IdentityDeps = {}): ProcStat | undefined {
  const text = resolveDeps(d).readFile(`/proc/${pid}/stat`);
  if (text === null) return undefined;
  const f = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const r = {
    ppid: Number(f[1]),
    pgrp: Number(f[2]),
    sid: Number(f[3]),
    startTicks: Number(f[19]),
  };
  return Object.values(r).every(Number.isFinite) ? r : undefined;
}

let linuxBootCache: string | null | undefined;
/** macOS and Windows: the boot is stable within a run, and the probe costs a process start (PowerShell: 0.5-2 s). */
let offLinuxBootCache: string | null | undefined;

/** Forget the cached boot identities (tests). */
export function resetBootCache(): void {
  linuxBootCache = undefined;
  offLinuxBootCache = undefined;
}

/**
 * The current boot: the Linux boot id (a uuid), or `boottime:<epoch seconds>` on macOS and Windows.
 * Null when it cannot be determined (then nothing may be killed or refused on its account).
 */
export function bootIdentity(d: IdentityDeps = {}): string | null {
  const { platform, run, readFile } = resolveDeps(d);
  if (platform === "linux") {
    if (d.readFile === undefined && linuxBootCache !== undefined) return linuxBootCache;
    const id = readFile("/proc/sys/kernel/random/boot_id")?.trim() || null;
    if (d.readFile === undefined) linuxBootCache = id;
    return id;
  }
  if (platform === "darwin" || platform === "win32") {
    if (d.run === undefined && offLinuxBootCache !== undefined) return offLinuxBootCache;
    const id = platform === "darwin" ? darwinBoot(run) : windowsBoot(run);
    if (d.run === undefined && id !== null) offLinuxBootCache = id;
    return id;
  }
  return null;
}

function darwinBoot(run: (cmd: string, args: string[]) => string | null): string | null {
  // `{ sec = 1730000000, usec = 123456 } Fri Nov  1 08:00:00 2026`
  const sec = /sec\s*=\s*(\d+)/.exec(run("sysctl", ["-n", "kern.boottime"]) ?? "")?.[1];
  return sec ? `boottime:${sec}` : null;
}

function windowsBoot(run: (cmd: string, args: string[]) => string | null): string | null {
  const ps = run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
  ])?.trim();
  const parsed = ps ? Date.parse(ps) : Number.NaN;
  if (Number.isFinite(parsed)) return `boottime:${Math.floor(parsed / 1000)}`;
  // `LastBootUpTime=20261101080000.500000+000`
  const w = /LastBootUpTime=(\d{14})(?:\.\d+)?([+-]\d+)?/.exec(
    run("wmic", ["os", "get", "LastBootUpTime", "/format:list"]) ?? "",
  );
  if (w) {
    const t = w[1]!;
    const ms = Date.UTC(
      +t.slice(0, 4),
      +t.slice(4, 6) - 1,
      +t.slice(6, 8),
      +t.slice(8, 10),
      +t.slice(10, 12),
      +t.slice(12, 14),
    );
    // The offset is in minutes east of UTC; wmic prints local time.
    return `boottime:${Math.floor((ms - Number(w[2] ?? 0) * 60_000) / 1000)}`;
  }
  return null;
}

/** Two boot identities name the same boot. Boot times may differ by a few seconds between reads. */
export function sameBoot(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ta = /^boottime:(\d+)$/.exec(a)?.[1];
  const tb = /^boottime:(\d+)$/.exec(b)?.[1];
  if (ta !== undefined && tb !== undefined) return Math.abs(Number(ta) - Number(tb)) <= 10;
  return a === b;
}

export interface ProcessProbe {
  /** Linux: field 22 of /proc/<pid>/stat. */
  startTicks: number | null;
  /** macOS: `ps` lstart. Windows: the CIM creation time. */
  startTime: string | null;
  ppid: number | null;
  /** Windows: PowerShell failed and `wmic` supplied `startTime`. */
  fellBack?: boolean;
}

const validPid = (pid: number) => Number.isInteger(pid) && pid > 0;

/** The process with this pid right now, or undefined when it is gone or cannot be read. */
export function probeProcess(pid: number, d: IdentityDeps = {}): ProcessProbe | undefined {
  if (!validPid(pid)) return undefined;
  const { platform, run } = resolveDeps(d);
  if (platform === "linux") {
    const s = readProcStat(pid, d);
    return s ? { startTicks: s.startTicks, startTime: null, ppid: s.ppid } : undefined;
  }
  if (platform === "darwin") {
    // `  4321 Mon Nov  2 17:30:07 2026`
    const out = run("ps", ["-o", "ppid=,lstart=", "-p", String(pid)]);
    const m = /^\s*(\d+)\s+(\S.*\S)\s*$/m.exec(out ?? "");
    return m ? { startTicks: null, startTime: m[2]!, ppid: Number(m[1]) } : undefined;
  }
  if (platform === "win32") {
    const ps = run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') + '|' + $p.ParentProcessId }`,
    ]);
    const m = /^(\S+)\|(\d+)\s*$/m.exec(ps ?? "");
    if (m) return { startTicks: null, startTime: m[1]!, ppid: Number(m[2]) };
    const w = run("wmic", [
      "process",
      "where",
      `ProcessId=${pid}`,
      "get",
      "CreationDate,ParentProcessId",
      "/format:list",
    ]);
    const created = /CreationDate=(\S+)/.exec(w ?? "")?.[1];
    const parent = /ParentProcessId=(\d+)/.exec(w ?? "")?.[1];
    return created
      ? {
          startTicks: null,
          startTime: created,
          ppid: parent ? Number(parent) : null,
          fellBack: true,
        }
      : undefined;
  }
  return undefined;
}

/** What a runner records about the agent it started (the pid record, and the task's frontmatter). */
export interface AgentIdentity {
  pgid: number;
  command: string;
  bootId: string | null;
  startTicks: number | null;
  startTime: string | null;
}

/**
 * Is the recorded agent still running? `running`: the same boot, the process exists and its start
 * time equals the recorded one exactly. `gone`: it does not exist, or is another process (a reused
 * pid), or the machine rebooted. `unknown`: not enough was recorded, the probe failed, or (Windows)
 * the recorded start time and the probed one are different formats, or the probe fell back to
 * `wmic` and the strings differ. Callers must not kill and must not refuse on `unknown`.
 */
export function agentStatus(
  id: AgentIdentity,
  d: IdentityDeps = {},
): "running" | "gone" | "unknown" {
  const { platform } = resolveDeps(d);
  const recordedStart = platform === "linux" ? id.startTicks : id.startTime;
  if (!id.bootId || recordedStart === null || recordedStart === undefined) return "unknown";
  const boot = bootIdentity(d);
  if (!boot) return "unknown";
  if (!sameBoot(id.bootId, boot)) return "gone";
  const probe = probeProcess(id.pgid, d);
  // A probe that failed (no `ps`, PowerShell blocked, a timeout) looks like "no such process":
  // only a pid that is really gone is `gone`; a live one cannot be told apart, so it is unknown.
  if (!probe) return resolveDeps(d).alive(id.pgid) ? "unknown" : "gone";
  const now = platform === "linux" ? probe.startTicks : probe.startTime;
  if (now === recordedStart) return "running";
  // `wmic` prints `YYYYMMDDHHMMSS.mmmmmm±UUU`. That is not the ISO form the writer prefers, so a
  // mismatch is not proof the pid was reused. A fallback that disagrees is the same: unverifiable.
  if (
    platform === "win32" &&
    typeof now === "string" &&
    typeof recordedStart === "string" &&
    (probe.fellBack === true || windowsTimeKind(now) !== windowsTimeKind(recordedStart))
  ) {
    return "unknown";
  }
  return "gone";
}

/** `wmic` CreationDate: `YYYYMMDDHHMMSS.mmmmmm±UUU`. */
const WMIC_CREATION = /^\d{14}\.\d+[+-]\d+$/;

/** Fixed-width UTC form of a CIM `CreationDate` (`DateTime.ToString('o')`). */
export const ISO_O = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/;

/** Which Windows creation-time spelling this string is. Different kinds are not comparable. */
export function windowsTimeKind(value: string): "iso" | "wmic" | "other" {
  if (ISO_O.test(value)) return "iso";
  if (WMIC_CREATION.test(value)) return "wmic";
  return "other";
}

/** One row of the Windows process table. `created` is the CIM CreationDate in UTC, ISO 8601 ("o"). */
export interface ProcessRow {
  pid: number;
  ppid: number;
  created: string;
}

/**
 * A Windows process table.
 * `droppedNonIso` counts `pid|ppid|time` rows whose time was not `ISO_O`.
 * `unparsed` counts other non-empty lines (a header, spaces around the pipes, an error on stdout).
 * Those lines are not "no such process": a table that parsed nothing, or that lost lines, must not
 * be read as "the agent is gone".
 */
export interface ProcessTable {
  rows: ProcessRow[];
  droppedNonIso: number;
  unparsed: number;
}

const PROCESS_TABLE_COMMAND =
  "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '' + $_.ProcessId + '|' + $_.ParentProcessId + '|' + $_.CreationDate.ToUniversalTime().ToString('o') } }";

const powershellArgs = (command: string): string[] => [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  command,
];

/** Split one CIM table listing. Blank lines are ignored. */
export function parseProcessTable(out: string): ProcessTable {
  const rows: ProcessRow[] = [];
  let droppedNonIso = 0;
  let unparsed = 0;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^(\d+)\|(\d+)\|(\S+)\s*$/.exec(line);
    if (!m) {
      unparsed += 1;
      continue;
    }
    if (!ISO_O.test(m[3]!)) {
      droppedNonIso += 1;
      continue;
    }
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: m[3]! });
  }
  return { rows, droppedNonIso, unparsed };
}

/**
 * Windows: every process with its parent and creation time, from ONE CIM query (null when
 * PowerShell fails). Rows whose creation time is not the fixed-width UTC form are dropped and
 * counted, and so is every non-empty line that is not `pid|ppid|time`. An empty `rows` with
 * either counter non-zero means the listing was unreadable, not that the machine has no processes.
 * Callers must not treat that as "the agent is gone".
 */
export function processTable(d: IdentityDeps = {}): ProcessTable | null {
  const { platform, run } = resolveDeps(d);
  if (platform !== "win32") return null;
  const out = run("powershell", powershellArgs(PROCESS_TABLE_COMMAND));
  if (out === null) return null;
  return parseProcessTable(out);
}

/**
 * Same query as {@link processTable}, without `spawnSync` on the caller's event loop.
 * Null on any failure, a non-zero exit, or the timeout (the probe is killed).
 */
export async function processTableAsync(
  d: IdentityDeps & {
    runAsync?: (
      cmd: string,
      args: string[],
      opts?: { input?: string; timeoutMs?: number },
    ) => Promise<string | null>;
  } = {},
): Promise<ProcessTable | null> {
  const platform = d.platform ?? process.platform;
  if (platform !== "win32") return null;
  const run = d.runAsync ?? runProbeAsync;
  const out = await run("powershell", powershellArgs(PROCESS_TABLE_COMMAND));
  if (out === null) return null;
  return parseProcessTable(out);
}

/**
 * Run a probe without blocking the event loop. Stdout, or null on any failure, non-zero exit,
 * or timeout. A missing binary (the sync probe's `{ status: null, error: ENOENT }`) is null.
 */
export function runProbeAsync(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "ignore"],
        env: probeEnv(),
      });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? out : null));
    if (opts.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.input);
    }
  });
}

/**
 * The pids that really descend from the root process: walking down from the root, a process counts
 * as a child only when it was created strictly AFTER its parent. Windows does not reparent
 * orphans, so a process may still name a long-dead (and since reused) pid as its parent; the
 * creation order is what tells a real child from a stranger that happens to list the pid.
 * Deepest first, the root itself not included.
 */
export function verifiedDescendants(rootPid: number, rows: ProcessRow[]): number[] {
  const root = rows.find((r) => r.pid === rootPid);
  if (!root) return [];
  const seen = new Set<number>([rootPid]);
  const order: number[] = [];
  const queue: ProcessRow[] = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const row of rows) {
      if (row.ppid !== parent.pid || seen.has(row.pid) || !(row.created > parent.created)) continue;
      seen.add(row.pid);
      order.push(row.pid);
      queue.push(row);
    }
  }
  return order.reverse();
}

/**
 * macOS: is this process group the runner's own? True when the pgid equals the runner's
 * process group; undefined when `ps` cannot say (a caller must then not kill). Other
 * platforms: false (Linux checks /proc, Windows has no groups).
 *
 * `ps -o sess=` prints 0 for every process on macOS, so a session compare treats every
 * process as the runner's own and never kills an orphan. A different process group is
 * not the runner's group; signalling it does not signal the runner.
 */
export function sharesRunnerGroup(pgid: number, d: IdentityDeps = {}): boolean | undefined {
  const { platform, run } = resolveDeps(d);
  if (platform !== "darwin") return false;
  const self = /^\s*(\d+)\s*$/m.exec(run("ps", ["-o", "pgid=", "-p", String(process.pid)]) ?? "");
  if (!self) return undefined;
  return Number(self[1]) === pgid;
}

/** One process to stop: its pid and the creation time it was verified to have (`ISO_O`). */
export interface VerifiedProcess {
  pid: number;
  created: string;
}

/** The 100 ns count since the Unix epoch of a fixed-width UTC `'o'` time, as a digit string. */
export function ticksOf(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{7})Z$/.exec(iso);
  if (!m) throw new Error(`not a fixed-width UTC time: ${iso}`);
  return String(BigInt(Date.parse(`${m[1]}Z`) / 1000) * 10_000_000n + BigInt(m[2]!));
}

/**
 * Does a held process's start time (100 ns ticks since the Unix epoch, as Windows keeps it) match
 * the verified one? The verified time comes from WMI/CIM, which holds whole microseconds (the 7th
 * digit is always 0), so the process's own time is cut to whole microseconds first. The kill script
 * does exactly this; this function is its reference.
 */
export function startTimeMatches(processTicks: bigint, verifiedTicks: bigint): boolean {
  return processTicks - (processTicks % 10n) === verifiedTicks;
}

/**
 * The kill script is fixed text; it targets Windows PowerShell 5.1 (also fine on 7). The pairs
 * arrive as JSON on stdin, never inside the script, with the time as a digit STRING of ticks so
 * `ConvertFrom-Json` (PowerShell 7 turns date-looking strings into dates) cannot touch it. For each
 * pair it opens the process (a held handle keeps Windows from handing the pid to someone else),
 * takes its start time in UTC (so a repeated DST hour cannot shift it), cuts it to whole
 * microseconds like {@link startTimeMatches}, and only on equality kills it.
 */
const KILL_SCRIPT =
  "$ErrorActionPreference = 'SilentlyContinue'; " +
  "foreach ($t in ($input | Out-String | ConvertFrom-Json)) { " +
  "$p = Get-Process -Id ([int]$t.pid); " +
  "if ($p) { $s = $p.StartTime.ToUniversalTime().Ticks - 621355968000000000; " +
  "$s = $s - ($s % 10); " +
  "if ($s -eq [long]$t.ticks) { $p.Kill() } } }";

/**
 * Windows: stop these processes, in the order given, from ONE PowerShell process. A pair whose
 * pid is not an integer or whose time is not the fixed UTC form is refused before anything runs.
 * Returns false when nothing could be run.
 */
function verifiedKillInvocation(list: VerifiedProcess[]): { args: string[]; input: string } | null {
  if (list.length === 0) return { args: [], input: "" };
  for (const t of list) {
    if (!validPid(t.pid) || !ISO_O.test(t.created)) return null;
  }
  return {
    args: powershellArgs(KILL_SCRIPT),
    input: JSON.stringify(list.map((t) => ({ pid: t.pid, ticks: ticksOf(t.created) }))),
  };
}

export function killVerified(list: VerifiedProcess[], d: IdentityDeps = {}): boolean {
  const prepared = verifiedKillInvocation(list);
  if (!prepared) return false;
  if (list.length === 0) return true;
  const { run } = resolveDeps(d);
  return run("powershell", prepared.args, { input: prepared.input }) !== null;
}

/** {@link killVerified} without a synchronous wait. False when the script cannot be run. */
export async function killVerifiedAsync(
  list: VerifiedProcess[],
  run: (
    cmd: string,
    args: string[],
    opts?: { input?: string; timeoutMs?: number },
  ) => Promise<string | null> = runProbeAsync,
): Promise<boolean> {
  const prepared = verifiedKillInvocation(list);
  if (!prepared) return false;
  if (list.length === 0) return true;
  return (await run("powershell", prepared.args, { input: prepared.input })) !== null;
}
