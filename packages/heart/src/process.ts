import { spawn, type ChildProcessByStdio, type SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import { writePidFile } from "./pid-file.js";
import {
  killVerifiedAsync,
  processTableAsync,
  verifiedDescendants,
  type ProcessTable,
  type VerifiedProcess,
} from "./process-identity.js";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stopped: boolean;
  /** True when the process was killed because the steer signal file appeared (not a stop). */
  steered: boolean;
  /** True when the process was killed for printing nothing for `idleTimeoutMs`. */
  stalled: boolean;
}

export interface ExecOptions {
  cwd: string;
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Called with each stdout/stderr chunk as it arrives, for live streaming to
   * the UI. The full output is still accumulated and returned on close.
   */
  onData?: (chunk: string) => void;
  /** File whose presence requests cooperative cancellation of the child process. */
  stopSignalPath?: string;
  /**
   * File whose presence asks to interrupt the child so the caller can rerun it with new
   * instructions. Killed like a stop, but the result has `steered: true`. The caller removes the
   * file; a stop request wins when both exist.
   */
  steerSignalPath?: string;
  /**
   * Written right after spawn with the child's process group (`PidRecord`) and removed when the
   * child closes; `recoverInterrupted` reaps what it names after a crash.
   */
  pidFilePath?: string;
  /**
   * Kill the child (SIGTERM, then SIGKILL) when it emits no stdout/stderr chunk
   * for this long; the result has `stalled: true`.
   */
  idleTimeoutMs?: number;
  /** Poll interval for stopSignalPath and steerSignalPath. Defaults to 500 ms. */
  stopPollMs?: number;
}

/** Linux's limit for one argv entry, NUL included. */
export const MAX_ARG_STRLEN = 131_072;

/** What the live Windows stop may call. Both are async: nothing on this path uses `spawnSync`. */
export interface WindowsTreeKillDeps {
  /** Process table. Null when the query fails or times out. */
  table?: () => Promise<ProcessTable | null>;
  /** Stop these verified processes (start time re-checked). False when it cannot be run. */
  killList?: (list: VerifiedProcess[]) => Promise<boolean>;
}

export interface ExecCommandDeps {
  /** Tests inject a platform. Production uses `process.platform`. */
  platform?: NodeJS.Platform;
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcessByStdio<Writable, Readable, Readable>;
  /** Live Windows stop. Tests inject the table and the verified-child kill. */
  windowsKill?: WindowsTreeKillDeps;
}

/**
 * Live Windows stop. Children created strictly after the root are stopped by {@link killVerifiedAsync}
 * (the same rule as the reaper: a stranger that still names this pid as its parent is left alone,
 * and each child's start time is checked again on an open handle). The root itself is stopped only
 * through `killRoot`, which must be `child.kill` — the handle Node already holds. Windows will not
 * reuse that pid until the handle closes. Never `taskkill /T`, and never a kill by pid number.
 * When the table cannot be read, only the root handle is killed.
 */
export async function killWindowsProcessTree(
  rootPid: number | undefined,
  killRoot: () => void,
  deps: WindowsTreeKillDeps = {},
): Promise<void> {
  try {
    if (rootPid !== undefined && Number.isInteger(rootPid) && rootPid > 0) {
      const table = await (deps.table ?? (() => processTableAsync()))();
      const root = table?.rows.find((row) => row.pid === rootPid);
      if (table && root) {
        const byPid = new Map(table.rows.map((row) => [row.pid, row]));
        const children = verifiedDescendants(rootPid, table.rows).flatMap((pid) => {
          const row = byPid.get(pid);
          return row ? [{ pid, created: row.created }] : [];
        });
        if (children.length > 0) await (deps.killList ?? killVerifiedAsync)(children);
      }
    }
  } catch {
    // A failed probe must not skip the root. The handle is still this process.
  } finally {
    killRoot();
  }
}

/**
 * Spawn a child process scoped to `cwd`, capture stdout/stderr, optionally feed
 * stdin, and enforce a timeout. Portable across Bun + Node (node:child_process
 * works on both). Never throws on non-zero exit — the caller inspects `code`.
 */
export function execCommand(
  command: string,
  args: string[],
  opts: ExecOptions,
  deps: ExecCommandDeps = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    // Node's spawn rejects argv entries / stdin containing NUL bytes. Agent
    // output (a plan, a diff) gets fed into the next step's prompt and can carry
    // a stray NUL — strip them so a poisoned prompt doesn't crash the run.
    const safeArgs = args.map((a) => a.replace(/\0/g, ""));
    const tooBig = safeArgs.findIndex((a) => Buffer.byteLength(a) + 1 > MAX_ARG_STRLEN);
    if (tooBig >= 0) {
      resolve({
        code: null,
        stdout: "",
        stderr: `argument ${tooBig + 1} is ${Buffer.byteLength(safeArgs[tooBig]!)} bytes, over the ${MAX_ARG_STRLEN}-byte limit of one argument (E2BIG)`,
        timedOut: false,
        stopped: false,
        steered: false,
        stalled: false,
      });
      return;
    }
    const platform = deps.platform ?? process.platform;
    const spawnFn = deps.spawn ?? spawn;
    // stdio is always three pipes, so stdout, stderr and stdin are present. The injected
    // spawn's return type says so; Node's own overloads only see that on an object literal.
    const child = spawnFn(command, safeArgs, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX: own process group, so a stop kills the agent and everything it spawned.
      // Windows has no groups. A stop kills verified children, then the root through this
      // handle. It does not walk parent ids (`taskkill /T`). windowsHide keeps a GUI parent
      // (the desktop app) from opening a console for git or an agent.
      detached: platform !== "win32",
      windowsHide: true,
    }) as ChildProcessByStdio<Writable, Readable, Readable>;
    const pidWritten =
      opts.pidFilePath && child.pid
        ? writePidFile(opts.pidFilePath, { pgid: child.pid, command: basename(command) }).catch(
            () => {},
          )
        : Promise.resolve();
    const cleanPid = async () => {
      await pidWritten;
      if (opts.pidFilePath) await rm(opts.pidFilePath, { force: true }).catch(() => {});
    };
    // One tree walk. A follow-up (the 1.5s SIGKILL) uses the handle and is skipped once the
    // child has exited: by then Windows may have given the pid to someone else, and the handle
    // is the only name that still means this process.
    let windowsLatched = false;
    const kill = (signal: NodeJS.Signals) => {
      if (platform === "win32") {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (windowsLatched) {
          try {
            child.kill(signal);
          } catch {
            /* already gone */
          }
          return;
        }
        windowsLatched = true;
        const killRoot = () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          try {
            child.kill(signal);
          } catch {
            /* already gone */
          }
        };
        void killWindowsProcessTree(child.pid, killRoot, deps.windowsKill).catch(() => {});
        return;
      }
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stopped = false;
    let steered = false;
    let stalled = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    let stopTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (stopTimer) clearInterval(stopTimer);
      if (killTimer) clearTimeout(killTimer);
      if (idleTimer) clearTimeout(idleTimer);
    };

    const armIdle = () => {
      if (!opts.idleTimeoutMs || opts.idleTimeoutMs <= 0 || stalled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        stalled = true;
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), 1500);
      }, opts.idleTimeoutMs);
    };
    armIdle();

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill("SIGKILL");
      }, opts.timeoutMs);
    }

    if (opts.stopSignalPath || opts.steerSignalPath) {
      stopTimer = setInterval(() => {
        if (stopped || steered) return;
        if (opts.stopSignalPath && existsSync(opts.stopSignalPath)) stopped = true;
        else if (opts.steerSignalPath && existsSync(opts.steerSignalPath)) steered = true;
        else return;
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), 1500);
      }, opts.stopPollMs ?? 500);
    }

    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      armIdle();
      opts.onData?.(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      armIdle();
      opts.onData?.(s);
    });

    child.on("error", async (err) => {
      clearTimers();
      await cleanPid();
      resolve({
        code: null,
        stdout,
        stderr: stderr + String(err),
        timedOut,
        stopped,
        steered,
        stalled,
      });
    });

    child.on("close", async (code) => {
      clearTimers();
      await cleanPid();
      resolve({ code, stdout, stderr, timedOut, stopped, steered, stalled });
    });

    // A child that exits before reading its stdin makes the write fail with
    // EPIPE. Without a listener that error is uncaught and kills the server.
    child.stdin.on("error", () => {});
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

/** Returns true if a command resolves on PATH (used by health checks). */
export async function commandExists(command: string): Promise<boolean> {
  const probe = process.platform === "win32" ? "where" : "which";
  const res = await execCommand(probe, [command], { cwd: process.cwd(), timeoutMs: 5000 });
  return res.code === 0;
}
