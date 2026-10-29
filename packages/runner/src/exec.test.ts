import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execCommand, MAX_ARG_STRLEN } from "./exec.js";

describe("execCommand", () => {
  it("refuses an argument over MAX_ARG_STRLEN with a clear error instead of E2BIG", async () => {
    const res = await execCommand("true", ["ok", "x".repeat(MAX_ARG_STRLEN)], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(res.code).toBeNull();
    expect(res.stderr).toBe(
      `argument 2 is ${MAX_ARG_STRLEN} bytes, over the ${MAX_ARG_STRLEN}-byte limit of one argument (E2BIG)`,
    );
    expect(
      (await execCommand("true", ["x".repeat(MAX_ARG_STRLEN - 1)], { cwd: process.cwd() })).code,
    ).toBe(0);
  });

  it("survives a child that exits before reading its stdin (no uncaught EPIPE)", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      // 8 MB is far more than a pipe buffer, so the write is still pending when
      // `true` exits; before the fix this raised an uncaught EPIPE.
      const res = await execCommand("true", [], {
        cwd: process.cwd(),
        input: "x".repeat(8 * 1024 * 1024),
        timeoutMs: 10000,
      });
      expect(res.code).toBe(0);
      await new Promise((r) => setTimeout(r, 100));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("a steer signal kills the whole process group and reports steered, not stopped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boof-exec-steer-"));
    try {
      const steer = join(dir, "steer");
      // The shell prints the pid of a background grandchild, then waits on it.
      let out = "";
      const running = execCommand("sh", ["-c", "sleep 60 & echo $!; wait"], {
        cwd: dir,
        steerSignalPath: steer,
        stopPollMs: 20,
        onData: (c) => (out += c),
      });
      await new Promise((r) => setTimeout(r, 300));
      await writeFile(steer, "x\n");
      const res = await running;
      expect(res.steered).toBe(true);
      expect(res.stopped).toBe(false);
      expect(res.timedOut).toBe(false);
      const grandchild = Number(out.trim());
      expect(grandchild).toBeGreaterThan(1);
      // The grandchild dies with the group (allow the SIGKILL grace).
      for (let i = 0; i < 40 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive(grandchild)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a stop signal wins over a steer signal, and neither is set when none appears", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boof-exec-steer-"));
    try {
      const stop = join(dir, "stop");
      const steer = join(dir, "steer");
      await writeFile(stop, "x\n");
      await writeFile(steer, "x\n");
      const both = await execCommand("sleep", ["60"], {
        cwd: dir,
        stopSignalPath: stop,
        steerSignalPath: steer,
        stopPollMs: 20,
      });
      expect(both.stopped).toBe(true);
      expect(both.steered).toBe(false);
      const none = await execCommand("true", [], { cwd: dir, steerSignalPath: steer + "-x" });
      expect(none.steered).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
