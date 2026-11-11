import { spawn, type ChildProcessByStdio, type SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import { writePidFile } from "./pid-file.js";
import {
  SandboxUnavailableError,
  sandboxApplier,
  type CommandLaunch,
  type SandboxSpawnPlan,
} from "./sandbox-launch.js";
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
  /**
   * How this child is started. Required: a missing launch is a refusal, not an unsandboxed
   * spawn. `direct` is today's spawn. `sandbox` is applied by the registered backend.
   */
  launch: CommandLaunch;
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
 * Same ceiling as `runProbeAsync`. A deps probe that never settles must not outlive the
 * real PowerShell probe, or a stop's `kill` would wait forever and the caller's timeout could not
 * end it.
 */
const PROBE_BOUND_MS = 5_000;
/** The Linux supervisor needs time to stop and reap a hostile fork storm. */
const SANDBOX_KILL_BOUND_MS = 10_000;

/**
 * `work`, or `fallback` when it is still pending after {@link PROBE_BOUND_MS}. A late rejection of
 * `work` is swallowed: the bound may already have won, and that rejection must not be unhandled.
 */
function withinProbeBound<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), PROBE_BOUND_MS);
  });
  work.catch(() => {
    /* A rejection that loses the race must not be unhandled. */
  });
  return Promise.race([work, bound]).finally(() => clearTimeout(timer));
}

/** macOS has no helper supervisor; walk the live process table and signal children first. */
export async function killDarwinProcessTree(root: number, signal: NodeJS.Signals): Promise<void> {
  const table = await new Promise<string>((resolve, reject) => {
    const child = spawn("ps", ["-axo", "pid=,ppid="], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (chunk) => (out += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(out) : reject(new Error("ps failed"))));
  });
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }
  const order: number[] = [];
  const visit = (pid: number, seen: Set<number>) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) visit(child, seen);
    order.push(pid);
  };
  visit(root, new Set());
  for (const pid of order) {
    try {
      process.kill(pid, signal);
    } catch {
      /* exited during the walk */
    }
  }
  try {
    process.kill(-root, signal);
  } catch {
    /* no remaining process group */
  }
}

/** What the live Windows stop may call. Both are async: nothing on this path uses `spawnSync`. */
export interface WindowsTreeKillDeps {
  /** Process table. Null when the query fails or times out. */
  table?: () => Promise<ProcessTable | null>;
  /** Stop these verified processes (start time re-checked). False when it cannot be run. */
  killList?: (list: VerifiedProcess[]) => Promise<boolean>;
  /**
   * After the table query resolves: false when the root pid may no longer be this child.
   * Node sets `exitCode` and `signalCode` and closes the process handle in the same `onexit`,
   * and Windows does not reuse a pid while that handle is open — so both still null means the
   * row at the root pid is ours. Once either is set, the row may be a stranger that reused the
   * pid: it is ignored and only `killRoot` runs. Omitted when the caller has no child handle
   * (the row is used).
   */
  rootStillOurs?: () => boolean;
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
 * When the table cannot be read, or `rootStillOurs` is false, only the root handle is killed.
 * The root is killed as soon as its children are pinned by creation time, so a child-kill probe
 * does not keep the agent alive. A probe that never returns still reaches `killRoot`.
 */
export async function killWindowsProcessTree(
  rootPid: number | undefined,
  killRoot: () => void,
  deps: WindowsTreeKillDeps = {},
): Promise<void> {
  let rooted = false;
  const finishRoot = () => {
    if (rooted) return;
    rooted = true;
    killRoot();
  };
  try {
    if (rootPid !== undefined && Number.isInteger(rootPid) && rootPid > 0) {
      const table = await withinProbeBound(
        Promise.resolve().then(() => (deps.table ?? (() => processTableAsync()))()),
        null,
      );
      // Checked after the snapshot, not before: `onexit` during the query means the pid may
      // already belong to someone else, and that row's children are not ours.
      const root =
        table && deps.rootStillOurs?.() !== false
          ? table.rows.find((row) => row.pid === rootPid)
          : undefined;
      if (table && root) {
        const byPid = new Map(table.rows.map((row) => [row.pid, row]));
        const children = verifiedDescendants(rootPid, table.rows).flatMap((pid) => {
          const row = byPid.get(pid);
          return row ? [{ pid, created: row.created }] : [];
        });
        finishRoot();
        if (children.length > 0) {
          await withinProbeBound((deps.killList ?? killVerifiedAsync)(children), false);
        }
      }
    }
  } catch {
    // A failed probe must not skip the root. The handle is still this process.
  } finally {
    finishRoot();
  }
}

/**
 * Spawn a child process scoped to `cwd`, capture stdout/stderr, optionally feed
 * stdin, and enforce a timeout. Portable across Bun + Node (node:child_process
 * works on both). Never throws on non-zero exit — the caller inspects `code`.
 * A missing or refused sandbox launch rejects before any process is started.
 */
export function execCommand(
  command: string,
  args: string[],
  opts: ExecOptions,
  deps: ExecCommandDeps = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const launch = opts.launch as CommandLaunch | undefined;
    if (!launch || (launch.kind !== "direct" && launch.kind !== "sandbox")) {
      reject(new SandboxUnavailableError("spawn launch is missing"));
      return;
    }
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
    let commandToRun = command;
    let argsToRun = safeArgs;
    let plan: SandboxSpawnPlan | undefined;
    if (launch.kind === "sandbox") {
      const apply = sandboxApplier();
      if (!apply) {
        reject(new SandboxUnavailableError("no sandbox backend is registered"));
        return;
      }
      try {
        plan = apply(launch, command, safeArgs, opts.env);
        commandToRun = plan.command;
        argsToRun = plan.args;
      } catch (err) {
        reject(sandboxRefusal(err));
        return;
      }
    }
    // Direct stdio is three pipes, so stdout, stderr and stdin are present. The injected
    // spawn's return type says so; Node's own overloads only see that on an object literal.
    // The sandbox adds a fourth pipe for the policy. The direct object stays as it is today.
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    if (plan) {
      child = spawnFn(commandToRun, argsToRun, {
        cwd: opts.cwd,
        env: plan.env,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        detached: platform !== "win32",
        windowsHide: true,
      }) as ChildProcessByStdio<Writable, Readable, Readable>;
      // A kill inside deliver must not surface as an unhandled error. The close path below
      // is not attached yet, and a refused launch never attaches it.
      child.on("error", () => {});
      try {
        plan.deliver(child);
      } catch (err) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        reject(sandboxRefusal(err));
        return;
      }
    } else {
      child = spawnFn(command, safeArgs, {
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
    }
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
    // One tree walk. A follow-up (the 1.5s SIGKILL, or a timeout that arrives while the walk
    // is in flight) must not kill the handle yet: TerminateProcess drops the root from the
    // process table, and the walk then finds no children. The follow-up runs after the walk.
    // The walk is bounded, so a probe that never returns still reaches the handle and this
    // kill does not wait forever. Once the child has exited, Windows may have given the pid
    // to someone else; the handle is the only name that still means this process, and the
    // walk ignores the table's row at that pid.
    let windowsLatched = false;
    let windowsWalk: Promise<void> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (platform === "win32") {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const killRoot = () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          try {
            child.kill(signal);
          } catch {
            /* already gone */
          }
        };
        if (windowsLatched) {
          void (windowsWalk ?? Promise.resolve()).then(killRoot);
          return;
        }
        windowsLatched = true;
        windowsWalk = killWindowsProcessTree(child.pid, killRoot, {
          ...deps.windowsKill,
          rootStillOurs: () => child.exitCode === null && child.signalCode === null,
        }).catch(() => {});
        return;
      }
      try {
        if (launch.kind === "sandbox" && platform === "darwin" && child.pid) {
          void killDarwinProcessTree(child.pid, signal).catch(() => {
            try {
              child.kill(signal);
            } catch {
              /* already gone */
            }
          });
        } else if (launch.kind === "sandbox") child.kill(signal);
        else if (child.pid) process.kill(-child.pid, signal);
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
        killTimer = setTimeout(
          () => kill("SIGKILL"),
          launch.kind === "sandbox" ? SANDBOX_KILL_BOUND_MS : 1500,
        );
      }, opts.idleTimeoutMs);
    };
    armIdle();

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        if (launch.kind === "sandbox") {
          kill("SIGTERM");
          killTimer = setTimeout(
            () => kill("SIGKILL"),
            launch.kind === "sandbox" ? SANDBOX_KILL_BOUND_MS : 1500,
          );
        } else {
          kill("SIGKILL");
        }
      }, opts.timeoutMs);
    }

    if (opts.stopSignalPath || opts.steerSignalPath) {
      stopTimer = setInterval(() => {
        if (stopped || steered) return;
        if (opts.stopSignalPath && existsSync(opts.stopSignalPath)) stopped = true;
        else if (opts.steerSignalPath && existsSync(opts.steerSignalPath)) steered = true;
        else return;
        kill("SIGTERM");
        killTimer = setTimeout(
          () => kill("SIGKILL"),
          launch.kind === "sandbox" ? SANDBOX_KILL_BOUND_MS : 1500,
        );
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

function sandboxRefusal(err: unknown): SandboxUnavailableError {
  return err instanceof SandboxUnavailableError
    ? err
    : new SandboxUnavailableError(err instanceof Error ? err.message : String(err));
}

/** Returns true if a command resolves on PATH (used by health checks). */
export async function commandExists(command: string): Promise<boolean> {
  const probe = process.platform === "win32" ? "where" : "which";
  const res = await execCommand(probe, [command], {
    cwd: process.cwd(),
    timeoutMs: 5000,
    launch: { kind: "direct" },
  });
  return res.code === 0;
}
