import { mkdtemp, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWrite, fileLockCount, syncDir, withFileLock } from "./atomic.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boof-atomic-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("withFileLock", () => {
  it("frees the map entry when the last holder releases", async () => {
    for (let i = 0; i < 20; i += 1) await withFileLock(join(dir, `f${i}`), async () => {});
    expect(fileLockCount()).toBe(0);
    let seenWhileHeld = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withFileLock(join(dir, "one"), async () => {
          seenWhileHeld = fileLockCount();
        }),
      ),
    );
    expect(seenWhileHeld).toBe(1);
    expect(fileLockCount()).toBe(0);
  });

  it("serializes callers on one path and still releases when fn throws", async () => {
    let active = 0;
    let maxActive = 0;
    const work = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    };
    await Promise.all(Array.from({ length: 8 }, () => withFileLock(join(dir, "p"), work)));
    expect(maxActive).toBe(1);
    await expect(
      withFileLock(join(dir, "p"), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fileLockCount()).toBe(0);
    await withFileLock(join(dir, "p"), async () => {}); // not deadlocked
  });
});

describe("atomicWrite", () => {
  it("exclusive write refuses an existing path and leaves it unchanged", async () => {
    const dest = join(dir, "t.md");
    await atomicWrite(dest, "first\n", { exclusive: true });
    await expect(atomicWrite(dest, "second\n", { exclusive: true })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(dest, "utf8")).toBe("first\n");
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("fsyncs the temp file before the rename and the directory after it", async () => {
    const probe = await open(join(dir, "probe"), "w");
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const dest = join(dir, "settings.json");
    const destExistedAtSync: boolean[] = [];
    const sync = vi.spyOn(proto, "sync").mockImplementation(async function (this: unknown) {
      destExistedAtSync.push(existsSync(dest));
    });
    await atomicWrite(dest, "{}\n", 0o600);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(destExistedAtSync).toEqual([false, true]);
    expect(await readFile(dest, "utf8")).toBe("{}\n");
    expect((await stat(dest)).mode & 0o777).toBe(0o600);
  });

  it("skips the directory sync when the directory cannot be opened (Windows)", async () => {
    const eisdir = (async () => {
      throw Object.assign(new Error("EISDIR: illegal operation"), { code: "EISDIR" });
    }) as unknown as typeof open;
    await expect(syncDir(dir, eisdir)).resolves.toBeUndefined();
    const eio = (async () => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    }) as unknown as typeof open;
    await expect(syncDir(dir, eio)).rejects.toThrow("EIO");
    const dest = join(dir, "after.json");
    await atomicWrite(dest, "new\n");
    expect(await readFile(dest, "utf8")).toBe("new\n");
  });
});
