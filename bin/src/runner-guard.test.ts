import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentBootId, dataRootPaths, processStartTicks } from "@boof-runner/shared";
import { RunnerGuard } from "./runner-guard.js";

let root: string;
let pidFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-guard-"));
  pidFile = dataRootPaths(root).runnerPid;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe("RunnerGuard", () => {
  it("is held after acquire and free after release", async () => {
    const guard = new RunnerGuard(root);
    expect(await guard.acquire()).toBe(true);
    expect(await guard.isHeld()).toBe(true);
    // A second guard on the same root, even in this process, is refused.
    expect(await new RunnerGuard(root).acquire()).toBe(false);
    await guard.release();
    expect(await exists(pidFile)).toBe(false);
    expect(await new RunnerGuard(root).acquire()).toBe(true);
  });

  it("names its pid and, where the system has them, the boot and the start time", async () => {
    await new RunnerGuard(root).acquire();
    const [pid, boot, ticks] = (await readFile(pidFile, "utf8")).trim().split(" ");
    expect(pid).toBe(String(process.pid));
    expect(boot).toBe(currentBootId());
    if (process.platform === "linux") expect(ticks).toMatch(/^\d+$/);
  });

  it("does not remove a guard that another process took over", async () => {
    const guard = new RunnerGuard(root);
    await guard.acquire();
    await writeFile(pidFile, `${process.ppid}\n`); // another process owns it now
    await guard.release();
    expect(await exists(pidFile)).toBe(true);
  });

  describe("a guard file left behind", () => {
    it("by a dead process is taken over", async () => {
      await writeFile(pidFile, "99999999\n");
      expect(await new RunnerGuard(root).acquire()).toBe(true);
    });

    it("by a process of an earlier boot that has a live pid now is taken over", async () => {
      await writeFile(pidFile, `${process.ppid} 33333333-3333-4333-8333-333333333333\n`);
      const guard = new RunnerGuard(root);
      // Only decisive where this system has a boot id.
      expect(await guard.acquire()).toBe(currentBootId() === undefined ? false : true);
    });

    it("by a live process in the old pid-only format still refuses", async () => {
      await writeFile(pidFile, `${process.ppid}\n`);
      expect(await new RunnerGuard(root).acquire()).toBe(false);
    });

    it.runIf(process.platform === "linux")(
      "whose pid is live but started at another time (pid reused in this boot) is taken over",
      async () => {
        await writeFile(pidFile, `${process.ppid} ${currentBootId()} 1\n`);
        expect(await new RunnerGuard(root).acquire()).toBe(true);
      },
    );

    it("of a live holder with a matching identity refuses", async () => {
      // Our parent, described the way a live runner describes itself.
      const boot = currentBootId();
      const ticks = processStartTicks(process.ppid);
      await writeFile(
        pidFile,
        [process.ppid, boot, ticks].filter((x) => x != null).join(" ") + "\n",
      );
      expect(await new RunnerGuard(root).acquire()).toBe(false);
    });
  });
});

describe("RunnerGuard across processes", () => {
  const child = fileURLToPath(new URL("../test-support/guard-child.mts", import.meta.url));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  interface Report {
    acquired: boolean;
    at: number;
    releasing?: number;
  }
  const run = (mode: string, startAt: number, holdMs: number) =>
    new Promise<Report>((resolve, reject) => {
      execFile(
        process.execPath,
        ["--import", "tsx", child, root, mode, String(startAt), String(holdMs)],
        { cwd: repoRoot },
        (err, stdout, stderr) => {
          // A crashing child exits by signal: its first line is still there.
          const lines = stdout.trim().split("\n").filter(Boolean);
          if (lines.length === 0) return reject(new Error(`${err?.message}\n${stderr}`));
          const report: Report = JSON.parse(lines[0]);
          if (lines[1]) report.releasing = JSON.parse(lines[1]).releasing;
          resolve(report);
        },
      );
    });

  // Not "exactly one wins": under load one child can start (tsx) after the other has already
  // released, and then both rightly acquire in turn. What must hold is that the intervals during
  // which two children held the guard never overlap, and that at least one got it.
  it("two processes starting together never hold the guard at once", async () => {
    const startAt = Date.now() + 1500;
    const results = await Promise.all([run("hold", startAt, 800), run("hold", startAt, 800)]);
    const held = results.filter((r) => r.acquired);
    expect(held.length).toBeGreaterThanOrEqual(1);
    expect(held.every((r) => r.releasing !== undefined)).toBe(true);
    if (held.length === 2) {
      const [first, second] = [...held].sort((a, b) => a.at - b.at);
      // The second one got it only after the first was releasing it.
      expect(second.at).toBeGreaterThanOrEqual(first.releasing!);
    }
    // It was released at the end, so the next start can take it.
    expect(await new RunnerGuard(root).acquire()).toBe(true);
  }, 30_000);

  it("after a crash (SIGKILL, no release) the next start takes it over", async () => {
    expect(await run("crash", Date.now(), 0)).toMatchObject({ acquired: true });
    expect(await exists(pidFile)).toBe(true); // left behind
    expect(await new RunnerGuard(root).acquire()).toBe(true);
  }, 30_000);
});
