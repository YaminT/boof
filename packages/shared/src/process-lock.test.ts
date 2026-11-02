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
    const boot = currentBootId();
    expect(seen).toBe(boot ? `${process.pid} ${boot}\n` : `${process.pid}\n`);
    await expect(stat(lock)).rejects.toThrow();
  });

  it("currentBootId is a stable per-boot uuid, or undefined when the system has none", () => {
    const id = currentBootId();
    if (id !== undefined) expect(id).toMatch(/^[0-9a-f][0-9a-f-]{15,}$/i);
    expect(currentBootId()).toBe(id);
  });
});

describe("a lock left by a process that is gone", () => {
  const THIS = "11111111-1111-4111-8111-111111111111";
  const EARLIER = "22222222-2222-4222-8222-222222222222";

  it("is taken over when it names another boot, even if its pid is alive now", async () => {
    // The pid exists (our parent), but the lock was written before a reboot: pid reuse.
    await writeFile(lock, `${process.ppid} ${EARLIER}\n`);
    expect(await run({ ...fast, bootId: THIS })).toBe("ran");
  });

  it("is still honoured when it names this boot and a live pid", async () => {
    await writeFile(lock, `${process.ppid} ${THIS}\n`);
    await expect(run({ ...fast, bootId: THIS })).rejects.toThrow(/busy/);
  });

  // A boot id decides only when both sides have a real per-boot uuid. A process that cannot read
  // one (a sandbox with /proc masked, a platform without it) must not take a live holder's lock.
  it("waits for a live holder when this process has no boot id", async () => {
    await writeFile(lock, `${process.ppid} ${EARLIER}\n`);
    await expect(run({ ...fast, bootId: null })).rejects.toThrow(/busy/);
  });

  it("waits for a live holder whose lock names no boot id, and for a legacy t: id", async () => {
    for (const content of [`${process.ppid}\n`, `${process.ppid} t:1700000000\n`]) {
      await writeFile(lock, content);
      await expect(run({ ...fast, bootId: THIS })).rejects.toThrow(/busy/);
    }
  });

  it("a clock step does not matter: a live holder with a t: id is waited for whatever time we compute", async () => {
    await writeFile(lock, `${process.ppid} t:1700000000\n`);
    await expect(run({ ...fast, bootId: null })).rejects.toThrow(/busy/);
  });

  it("still reads the old pid-only format: a live pid waits, a dead one is taken over", async () => {
    await writeFile(lock, `${process.ppid}\n`);
    await expect(run()).rejects.toThrow(/busy/);
    await writeFile(lock, "99999999\n");
    expect(await run()).toBe("ran");
  });

  it("is taken over when it is empty and older than 30 s", async () => {
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
    await writeFile(lock, `${process.ppid}\n`);
    await expect(run()).rejects.toThrow(`busy ${process.ppid} ${lock}`);
  });
});

describe("the takeover guard", () => {
  it("is removed only by the process that made it", async () => {
    await writeFile(lock, "99999999\n"); // dead holder: stale
    const guard = `${lock}.takeover`;
    await run({
      ...fast,
      // While we hold the guard, another process replaces it (it went stale and was retaken).
      guardHeld: async () => {
        await writeFile(guard, "424242\n");
      },
    });
    expect((await readFile(guard, "utf8")).trim()).toBe("424242");
  });

  it("is removed after a normal takeover", async () => {
    await writeFile(lock, "99999999\n");
    expect(await run()).toBe("ran");
    await expect(stat(`${lock}.takeover`)).rejects.toThrow();
  });
});
