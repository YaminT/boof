import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stopped: boolean;
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
   * Kill the child (SIGTERM, then SIGKILL) when it emits no stdout/stderr chunk
   * for this long; the result has `stalled: true`.
   */
  idleTimeoutMs?: number;
  /** Poll interval for stopSignalPath. Defaults to 500 ms. */
  stopPollMs?: number;
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
): Promise<ExecResult> {
  return new Promise((resolve) => {
    // Node's spawn rejects argv entries / stdin containing NUL bytes. Agent
    // output (a plan, a diff) gets fed into the next step's prompt and can carry
    // a stray NUL — strip them so a poisoned prompt doesn't crash the run.
    const safeArgs = args.map((a) => a.replace(/\0/g, ""));
    const child = spawn(command, safeArgs, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group (POSIX): a stop, timeout or stall kills the agent CLI and
      // everything it spawned, not just the top process.
      detached: process.platform !== "win32",
    });
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

    if (opts.stopSignalPath) {
      stopTimer = setInterval(() => {
        if (stopped || !opts.stopSignalPath || !existsSync(opts.stopSignalPath)) return;
        stopped = true;
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

    child.on("error", (err) => {
      clearTimers();
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut, stopped, stalled });
    });

    child.on("close", (code) => {
      clearTimers();
      resolve({ code, stdout, stderr, timedOut, stopped, stalled });
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
