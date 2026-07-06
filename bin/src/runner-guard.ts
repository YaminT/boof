import { readFile, rm, writeFile } from "node:fs/promises";
import { dataPaths } from "@boof-runner/shared";

/**
 * Single-runner guard via a pidfile (cli-packaging spec). Prevents a second
 * competing runner from starting. Not an OS boot service — purely a per-machine
 * mutex while the app is running.
 */
export class RunnerGuard {
  private readonly pidFile: string;
  constructor(root: string) {
    this.pidFile = dataPaths(root).runnerPid;
  }

  /** True if another live process already holds the runner lock. */
  async isHeld(): Promise<boolean> {
    try {
      const pid = Number((await readFile(this.pidFile, "utf8")).trim());
      if (!pid || pid === process.pid) return false;
      // Signal 0 probes for process existence without killing it.
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH = no such process → stale pidfile, not held.
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
      return false;
    }
  }

  async acquire(): Promise<boolean> {
    if (await this.isHeld()) return false;
    await writeFile(this.pidFile, String(process.pid), "utf8");
    return true;
  }

  async release(): Promise<void> {
    await rm(this.pidFile, { force: true });
  }
}
