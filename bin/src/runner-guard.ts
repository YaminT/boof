import { dataRootPaths, inspectProcessLock, tryAcquireProcessLock } from "@boof/heart";
import type { HeldProcessLock } from "@boof/heart";

/**
 * Single-runner guard via a pid lock file, `<data>/.runner.pid` (cli-packaging spec). Prevents a
 * second competing runner from starting on one data root. Not an OS boot service: held from
 * `acquire` until `release` or the process's death.
 *
 * It is `tryAcquireProcessLock`: the file is created exclusively (two processes starting together
 * cannot both get it) and holds `<pid> <boot id> <start time>`, so a file left by a crash is taken
 * over by the next start, including after a reboot that reused the pid (another boot id) or a pid
 * reused inside one boot (another start time). A file in the old pid-only format is judged by its
 * pid alone.
 */
export class RunnerGuard {
  private readonly pidFile: string;
  private held: HeldProcessLock | null = null;

  constructor(root: string) {
    this.pidFile = dataRootPaths(root).runnerPid;
  }

  /** True if a live process (this one included, once it acquired) holds the runner lock. */
  async isHeld(): Promise<boolean> {
    return (await inspectProcessLock(this.pidFile)).held;
  }

  /** Take the runner lock; false when another live process, or this one, already holds it. */
  async acquire(): Promise<boolean> {
    const held = await tryAcquireProcessLock(this.pidFile);
    if (!held) return false;
    this.held = held;
    return true;
  }

  async release(): Promise<void> {
    const held = this.held;
    this.held = null;
    await held?.release();
  }
}
