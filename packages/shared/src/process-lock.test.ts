import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentBootId, withProcessLock, type ProcessLockOptions } from "./process-lock.js";

let dir: string;
let lock: string;
const fast: ProcessLockOptions = { lockTimeoutMs: 200, lockPollMs: 20 };
const timeoutError = (holder: string, path: string) => new Error(`busy ${holder} ${path}`);
const run = (opts: ProcessLockOptions = fast) =>
  withProcessLock(lock, opts, async () => "ran", timeoutError);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boof-runner-plock-"));
  lock = join(dir, "x.lock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the lock file content", () => {
  it("names the pid and the boot", async () => {
    let seen = "";
    await withProcessLock(
      lock,
      fast,
      async () => {
        seen = await readFile(lock, "utf8");
      },
      timeoutError,
    );
    expect(seen).toBe(`${process.pid} ${currentBootId()}\n`);
    await expect(stat(lock)).rejects.toThrow();
  });

  it("currentBootId is a stable, non-empty token without spaces", () => {
    expect(currentBootId()).toMatch(/^\S+$/);
    expect(currentBootId()).toBe(currentBootId());
  });
});

describe("a lock left by a process that is gone", () => {
  it("is taken over when it names another boot, even if its pid is alive now", async () => {
    // The pid exists (our parent), but the lock was written before a reboot: pid reuse.
    await writeFile(lock, `${process.ppid} some-earlier-boot\n`);
    expect(await run()).toBe("ran");
  });

  it("is still honoured when it names this boot and a live pid", async () => {
    await writeFile(lock, `${process.ppid} ${currentBootId()}\n`);
    await expect(run()).rejects.toThrow(/busy/);
  });

  it("still reads the old pid-only format: a live pid waits, a dead one is taken over", async () => {
    await writeFile(lock, `${process.ppid}\n`);
    await expect(run()).rejects.toThrow(/busy/);
    await writeFile(lock, "99999999\n");
    expect(await run()).toBe("ran");
  });

  it("is taken over when it is empty and older than a few seconds", async () => {
    await writeFile(lock, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await run()).toBe("ran");
  });

  it("an empty lock that is still fresh is a lock being written: it is waited for", async () => {
    await writeFile(lock, "");
    await expect(run()).rejects.toThrow(/busy/);
  });
});

describe("the timeout error", () => {
  it("gets the holder's pid and the lock path", async () => {
    await writeFile(lock, `${process.ppid} ${currentBootId()}\n`);
    await expect(run()).rejects.toThrow(`busy ${process.ppid} ${lock}`);
  });
});
