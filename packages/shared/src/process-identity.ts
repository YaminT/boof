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
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface IdentityDeps {
  platform?: NodeJS.Platform;
  /** Run a command and return its stdout, or null on any failure or timeout. */
  run?: (cmd: string, args: string[]) => string | null;
  /** Read a file as text, or null. */
  readFile?: (path: string) => string | null;
}

const defaultRun = (cmd: string, args: string[]): string | null => {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      // `ps` prints dates in the user's language otherwise.
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
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
  run: d.run ?? defaultRun,
  readFile: d.readFile ?? defaultRead,
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
  if (platform === "darwin") {
    // `{ sec = 1730000000, usec = 123456 } Fri Nov  1 08:00:00 2026`
    const sec = /sec\s*=\s*(\d+)/.exec(run("sysctl", ["-n", "kern.boottime"]) ?? "")?.[1];
    return sec ? `boottime:${sec}` : null;
  }
  if (platform === "win32") {
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
      ? { startTicks: null, startTime: created, ppid: parent ? Number(parent) : null }
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
 * pid), or the machine rebooted. `unknown`: not enough was recorded or the probe failed; callers
 * must not kill and must not refuse on it.
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
  if (!probe) return "gone";
  const now = platform === "linux" ? probe.startTicks : probe.startTime;
  return now === recordedStart ? "running" : "gone";
}
