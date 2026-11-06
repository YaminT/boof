import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import { writePidFile } from "./pid-file.js";

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

/**
 * Spawn a child process scoped to `cwd`, capture stdout/stderr, optionally feed
 * stdin, and enforce a timeout. Portable across Bun + Node (node:child_process
 * works on both). Never throws on non-zero exit — the caller inspects `code`.
 */
export function execCommand(
  command: string,
  args: string[],
  opts: ExecOptions,
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
    const child = spawn(command, safeArgs, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group (POSIX): a stop, timeout or stall kills the agent CLI and
      // everything it spawned, not just the top process.
      detached: process.platform !== "win32",
    });
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
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
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
