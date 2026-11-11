import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dataRootPaths } from "./paths.js";
import { EXTERNAL_RUN_ID, EXTERNAL_RUN_TOKEN_PREFIX, ExternalRunStore } from "./external-runs.js";

const fsCalls = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  const spy =
    <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
    (...a: A): R => {
      fsCalls.push(`${name} ${String(a[0])}`);
      return fn(...a);
    };
  return {
    ...real,
    readFile: spy("readFile", real.readFile as (...a: unknown[]) => unknown),
    rename: spy("rename", real.rename),
    rm: spy("rm", real.rm),
  };
});

const INPUT = {
  projectId: "shop",
  taskId: "t1",
  stepId: "ci",
  kind: "step" as const,
  ttlMs: 60_000,
};
const RESULT = { status: "ok" as const, report: "all green", summary: "fine" };

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-xr-"));
  dir = dataRootPaths(root).externalRuns;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function files(): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

function skipAclGuardForStress(store: ExternalRunStore): void {
  // Keep this race focused on close arbitration and Windows filesystem semantics. ACL checks
  // have their own tests and are especially expensive when repeated hundreds of times.
  Object.defineProperty(store, "guard", { value: async () => {} });
}

describe("ExternalRunStore", () => {
  it("open returns an xr- id and a bxs_ token; the folder holds only the hash", async () => {
    const store = new ExternalRunStore(root);
    const { runId, token, expiresAt } = await store.open(INPUT);
    expect(runId).toMatch(EXTERNAL_RUN_ID);
    expect(token.startsWith(EXTERNAL_RUN_TOKEN_PREFIX)).toBe(true);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    for (const f of await files()) {
      expect(await readFile(join(dir, f), "utf8")).not.toContain(token);
    }
    expect(await files()).toEqual([`${runId}.json`]);
  });

  it("verify: right token → record; wrong token, other run's token, undefined, '' → null", async () => {
    const store = new ExternalRunStore(root);
    const a = await store.open(INPUT);
    const b = await store.open({ ...INPUT, taskId: "t2" });
    const rec = await store.verify(a.runId, a.token);
    expect(rec).toMatchObject({
      runId: a.runId,
      projectId: "shop",
      taskId: "t1",
      stepId: "ci",
      kind: "step",
    });
    expect(await store.verify(a.runId, a.token + "x")).toBeNull();
    expect(await store.verify(a.runId, b.token)).toBeNull();
    expect(await store.verify(a.runId, undefined)).toBeNull();
    expect(await store.verify(a.runId, "")).toBeNull();
    expect(await store.verify(a.runId, "nope_" + a.token.slice(4))).toBeNull();
  });

  it("verify: expired (now = expiresAt + 1) → null", async () => {
    let now = 1_000_000;
    const store = new ExternalRunStore(root, () => now);
    const r = await store.open(INPUT);
    expect(await store.verify(r.runId, r.token)).not.toBeNull();
    now = Date.parse(r.expiresAt) + 1;
    expect(await store.verify(r.runId, r.token)).toBeNull();
  });

  it("malformed ids ('../x', 'xr-XYZ', 1000 chars) answer null/false and touch no file", async () => {
    const store = new ExternalRunStore(root);
    const live = await store.open(INPUT);
    const before = await files();
    for (const id of [
      "../x",
      "../../settings",
      "xr-XYZ",
      "xr-" + "a".repeat(997),
      "XR-" + "0".repeat(32),
    ]) {
      expect(await store.verify(id, live.token)).toBeNull();
      expect(await store.complete(id, RESULT)).toBe(false);
      expect(await store.cancel(id)).toBe(false);
      expect(await store.result(id)).toBeNull();
      await store.discard(id);
    }
    expect(await files()).toEqual(before);
  });

  it("complete once → true; again → false; result readable", async () => {
    const store = new ExternalRunStore(root);
    const r = await store.open(INPUT);
    expect(await store.complete(r.runId, RESULT)).toBe(true);
    expect(await store.complete(r.runId, { ...RESULT, report: "other" })).toBe(false);
    const res = await store.result(r.runId);
    expect(res).toMatchObject(RESULT);
    expect(Date.parse(res!.receivedAt)).not.toBeNaN();
    expect(await store.verify(r.runId, r.token)).toBeNull();
    expect(await files()).toEqual([`${r.runId}.result.json`]);
  });

  it("complete and cancel raced 20 times: exactly one wins each time", async () => {
    const store = new ExternalRunStore(root);
    for (let i = 0; i < 20; i++) {
      const r = await store.open(INPUT);
      const [c, x] = await Promise.all([store.complete(r.runId, RESULT), store.cancel(r.runId)]);
      expect(Number(c) + Number(x)).toBe(1);
      expect(await store.result(r.runId)).toEqual(c ? expect.objectContaining(RESULT) : null);
    }
    expect((await files()).filter((f) => f.endsWith(".closed"))).toEqual([]);
    // Each open, complete and cancel re-reads the Windows ACL.
  }, 90_000);

  it.skipIf(process.platform !== "win32")(
    "Windows stress: complete and cancel have exactly one winner over 300 races",
    async () => {
      const store = new ExternalRunStore(root);
      skipAclGuardForStress(store);
      for (let i = 0; i < 300; i++) {
        const r = await store.open(INPUT);
        const [complete, cancel] = await Promise.all([
          store.complete(r.runId, RESULT),
          store.cancel(r.runId),
        ]);
        expect(Number(complete) + Number(cancel)).toBe(1);
      }
      expect((await files()).some((f) => f.endsWith(".closed"))).toBe(false);
    },
    180_000,
  );

  it.skipIf(process.platform !== "win32")(
    "Windows stress: a one-shot EPERM during result rename cannot create a second winner",
    async () => {
      let enteredRename!: () => void;
      let releaseRename!: () => void;
      const atRename = new Promise<void>((resolve) => (enteredRename = resolve));
      const blockedRename = new Promise<void>((resolve) => (releaseRename = resolve));
      let inject = true;
      const store = new ExternalRunStore(root, Date.now, async (from, to) => {
        if (inject && to.endsWith(".result.json")) {
          inject = false;
          enteredRename();
          await blockedRename;
          throw Object.assign(new Error("injected rename failure"), { code: "EPERM" });
        }
        return rename(from, to);
      });
      skipAclGuardForStress(store);
      const r = await store.open(INPUT);
      const completion = store.complete(r.runId, RESULT);
      await atRename;
      expect(await store.cancel(r.runId)).toBe(false);
      releaseRename();
      await expect(completion).rejects.toMatchObject({ code: "EPERM" });
      expect(await store.complete(r.runId, RESULT)).toBe(true);
      expect(await store.cancel(r.runId)).toBe(false);
    },
    30_000,
  );

  it("cancel then complete → false and no result", async () => {
    const store = new ExternalRunStore(root);
    const r = await store.open(INPUT);
    expect(await store.cancel(r.runId)).toBe(true);
    expect(await store.complete(r.runId, RESULT)).toBe(false);
    expect(await store.result(r.runId)).toBeNull();
    expect(await files()).toEqual([]);
  });

  it("two stores on one root: open in A, verify + complete in B, result seen by A", async () => {
    const a = new ExternalRunStore(root);
    const b = new ExternalRunStore(root);
    const r = await a.open(INPUT);
    expect(await b.verify(r.runId, r.token)).not.toBeNull();
    expect(await b.complete(r.runId, RESULT)).toBe(true);
    expect(await a.result(r.runId)).toMatchObject(RESULT);
  });

  it("discard removes the result", async () => {
    const store = new ExternalRunStore(root);
    const r = await store.open(INPUT);
    await store.complete(r.runId, RESULT);
    await store.discard(r.runId);
    expect(await store.result(r.runId)).toBeNull();
    expect(await files()).toEqual([]);
    await store.discard(r.runId); // no-op
  });

  it("a corrupt result is null with one console.error that does not quote the file", async () => {
    const store = new ExternalRunStore(root);
    const r = await store.open(INPUT);
    await store.complete(r.runId, RESULT);
    await writeFile(join(dir, `${r.runId}.result.json`), '{"status":"SECRET-TEXT"');
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await store.result(r.runId)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET-TEXT");
    } finally {
      spy.mockRestore();
    }
  });

  it("a result with unknown keys is rejected (strict)", async () => {
    const store = new ExternalRunStore(root);
    const r = await store.open(INPUT);
    await store.complete(r.runId, RESULT);
    await writeFile(
      join(dir, `${r.runId}.result.json`),
      JSON.stringify({ ...RESULT, receivedAt: new Date().toISOString(), extra: 1 }),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await store.result(r.runId)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("prune removes records and results past expiresAt + 24 h and keeps live ones", async () => {
    const day = 24 * 3600_000;
    let now = 10 * day;
    const store = new ExternalRunStore(root, () => now);
    const old = await store.open({ ...INPUT, ttlMs: 60_000 });
    const oldDone = await store.open({ ...INPUT, ttlMs: 60_000 });
    await store.complete(oldDone.runId, RESULT);
    now += 2 * day;
    const live = await store.open(INPUT);
    const liveDone = await store.open(INPUT);
    await store.complete(liveDone.runId, RESULT);
    // a stray .closed older than 1 h, and a fresh one
    const stray = join(dir, `xr-${"1".repeat(32)}.closed`);
    const fresh = join(dir, `xr-${"2".repeat(32)}.closed`);
    await writeFile(stray, "{}");
    await writeFile(fresh, "{}");
    const t = new Date(now - 2 * 3600_000);
    await utimes(stray, t, t);
    const ft = new Date(now);
    await utimes(fresh, ft, ft);
    const n = await store.prune();
    expect(n).toBe(3);
    const left = (await files()).sort();
    expect(left).toEqual(
      [`${live.runId}.json`, `${liveDone.runId}.result.json`, `xr-${"2".repeat(32)}.closed`].sort(),
    );
    expect(await store.verify(old.runId, old.token)).toBeNull();
    expect(await store.result(oldDone.runId)).toBeNull();
  });

  it("modes: folder 0700, files 0600", { skip: process.platform === "win32" }, async () => {
    const store = new ExternalRunStore(root);
    const r = await store.open(INPUT);
    const done = await store.open(INPUT);
    await store.complete(done.runId, RESULT);
    if (process.platform !== "win32") expect((await stat(dir)).mode & 0o777).toBe(0o700);
    if (process.platform !== "win32")
      expect((await stat(join(dir, `${r.runId}.json`))).mode & 0o777).toBe(0o600);
    if (process.platform !== "win32")
      expect((await stat(join(dir, `${done.runId}.result.json`))).mode & 0o777).toBe(0o600);
  });

  it("verify with a '../x' id never reads outside the folder, even when a valid record is there", async () => {
    const store = new ExternalRunStore(root);
    const live = await store.open(INPUT);
    const rec = JSON.parse(await readFile(join(dir, `${live.runId}.json`), "utf8"));
    // <root>/x.json is what dir/../x.json resolves to; give it a record with the live token's hash.
    await writeFile(join(root, "x.json"), JSON.stringify({ ...rec, runId: "../x" }));
    await writeFile(join(root, "x.closed"), "{}");
    fsCalls.length = 0;
    expect(await store.verify("../x", live.token)).toBeNull();
    expect(await store.complete("../x", RESULT)).toBe(false);
    expect(await store.cancel("../x")).toBe(false);
    expect(await store.result("../x")).toBeNull();
    await store.discard("../x");
    // the id check refuses before any read, rename or remove (the record's own runId check
    // would also answer null, so the outcome alone cannot show the id check is there)
    expect(fsCalls).toEqual([]);
    expect((await readdir(root)).sort()).toEqual(["external-runs", "x.closed", "x.json"]);
  });

  describe("prune grace", () => {
    const day = 24 * 3600_000;
    it("keeps an open record up to expiresAt + 24 h, drops it after", async () => {
      let now = 10 * day;
      const store = new ExternalRunStore(root, () => now);
      const a = await store.open({ ...INPUT, ttlMs: 60_000 });
      const exp = Date.parse(a.expiresAt);
      now = exp + 1; // past expiry, inside the grace
      expect(await store.prune()).toBe(0);
      now = exp + day; // boundary: `now > at + 24 h` is false
      expect(await store.prune()).toBe(0);
      now = exp + day + 1;
      expect(await store.prune()).toBe(1);
      expect(await files()).toEqual([]);
    });
    it("keeps a result received 24 h - 1 ms ago, drops it 1 ms later", async () => {
      let now = 10 * day;
      const store = new ExternalRunStore(root, () => now);
      const a = await store.open(INPUT);
      await store.complete(a.runId, RESULT); // receivedAt = 10 days
      now = 10 * day + day - 1;
      expect(await store.prune()).toBe(0);
      expect(await store.result(a.runId)).not.toBeNull();
      now = 10 * day + day + 1;
      expect(await store.prune()).toBe(1);
    });
    it("a .closed is aged from its close time and old temp files are pruned", async () => {
      const now = Date.now();
      const store = new ExternalRunStore(root, () => now);
      const a = await store.open(INPUT);
      const old = new Date(now - 5 * 3600_000);
      await utimes(join(dir, `${a.runId}.json`), old, old);
      // Close by hand like complete would, between rename and rm: mtime must become "now".
      const { rename: mv } = await import("node:fs/promises");
      await mv(join(dir, `${a.runId}.json`), join(dir, `${a.runId}.closed`));
      const tOld = join(dir, ".0123456789abcdef.tmp");
      const tNew = join(dir, ".fedcba9876543210.tmp");
      await writeFile(tOld, "{}");
      await writeFile(tNew, "{}");
      await utimes(tOld, new Date(now - 2 * 3600_000), new Date(now - 2 * 3600_000));
      expect(await store.prune()).toBe(2); // the old .closed (mtime kept from open) + old tmp
      expect((await files()).sort()).toEqual([".fedcba9876543210.tmp"]);
    });
  });

  describe("containment", { skip: process.platform === "win32" }, () => {
    it("a symlinked external-runs is refused: open throws, nothing is written outside, verify is null", async () => {
      const outside = await mkdtemp(join(tmpdir(), "boof-xr-out-"));
      try {
        await symlink(outside, dir);
        const store = new ExternalRunStore(root);
        await expect(store.open(INPUT)).rejects.toThrow(/real directory|symlink|refus|unsafe/i);
        expect(await readdir(outside)).toEqual([]);
        // a record planted behind the symlink is not honoured either
        const good = new ExternalRunStore(await mkdtemp(join(tmpdir(), "boof-xr-good-")));
        const r = await good.open(INPUT);
        await writeFile(
          join(outside, `${r.runId}.json`),
          await readFile(
            join(
              dataRootPaths((good as unknown as { root: string }).root).externalRuns,
              `${r.runId}.json`,
            ),
            "utf8",
          ),
        );
        expect(await store.verify(r.runId, r.token)).toBeNull();
        await expect(store.complete(r.runId, RESULT)).rejects.toThrow();
        expect(await readdir(outside)).toEqual([`${r.runId}.json`]);
        await rm((good as unknown as { root: string }).root, { recursive: true, force: true });
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("a group-writable external-runs folder is refused", async () => {
      const store = new ExternalRunStore(root);
      await store.open(INPUT);
      await chmod(dir, 0o770);
      await expect(store.open(INPUT)).rejects.toThrow();
      await chmod(dir, 0o700);
    });

    it("works under umask 002", async () => {
      const prev = process.umask(0o002);
      try {
        const store = new ExternalRunStore(root);
        const r = await store.open(INPUT);
        expect(await store.verify(r.runId, r.token)).not.toBeNull();
        expect(await store.complete(r.runId, RESULT)).toBe(true);
        expect(await store.prune()).toBe(0);
        if (process.platform !== "win32") expect((await stat(dir)).mode & 0o777).toBe(0o700);
      } finally {
        process.umask(prev);
      }
    });
  });

  describe("complete when the result cannot be stored", () => {
    it("blocked final path: the error is thrown and the run stays open for a retry", async () => {
      const store = new ExternalRunStore(root);
      const r = await store.open(INPUT);
      await mkdir(join(dir, `${r.runId}.result.json`, "x"), { recursive: true }); // rename onto a non-empty dir fails
      await expect(store.complete(r.runId, RESULT)).rejects.toThrow();
      expect(await store.verify(r.runId, r.token)).not.toBeNull();
      expect((await files()).filter((f) => f.endsWith(".tmp") || f.endsWith(".closed"))).toEqual(
        [],
      );
      await rm(join(dir, `${r.runId}.result.json`), { recursive: true });
      expect(await store.complete(r.runId, RESULT)).toBe(true);
      expect(await store.result(r.runId)).toMatchObject(RESULT);
    });

    it(
      "temp write fails: error thrown, run never closed",
      { skip: process.platform === "win32" || process.getuid?.() === 0 },
      async () => {
        const store = new ExternalRunStore(root);
        const r = await store.open(INPUT);
        await chmod(dir, 0o500);
        try {
          await expect(store.complete(r.runId, RESULT)).rejects.toThrow();
        } finally {
          await chmod(dir, 0o700);
        }
        expect(await store.verify(r.runId, r.token)).not.toBeNull();
        expect(await store.complete(r.runId, RESULT)).toBe(true);
      },
    );
  });

  it("open bounds ttlMs to 1 s .. 24 h", async () => {
    const store = new ExternalRunStore(root);
    for (const ttlMs of [0, 999, 24 * 3600_000 + 1, NaN, Infinity]) {
      await expect(store.open({ ...INPUT, ttlMs })).rejects.toThrow(RangeError);
    }
    await store.open({ ...INPUT, ttlMs: 1000 });
    await store.open({ ...INPUT, ttlMs: 24 * 3600_000 });
  });

  it("two real processes racing complete: exactly one wins and one result is stored", async () => {
    const store = new ExternalRunStore(root);
    const child = fileURLToPath(
      new URL("../test-support/external-runs-child.mts", import.meta.url),
    );
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const run = (runId: string, startAt: number, label: string) =>
      new Promise<{ won: boolean }>((resolve, reject) =>
        execFile(
          process.execPath,
          ["--import", "tsx", child, root, runId, String(startAt), label],
          { cwd: repoRoot },
          (err, stdout, stderr) =>
            err
              ? reject(new Error(`${err.message}\n${stderr}`))
              : resolve(JSON.parse(stdout.trim().split("\n").pop() as string)),
        ),
      );
    const r = await store.open(INPUT);
    const startAt = Date.now() + 1500;
    const [a, b] = await Promise.all([run(r.runId, startAt, "a"), run(r.runId, startAt, "b")]);
    expect(Number(a.won) + Number(b.won)).toBe(1);
    expect((await store.result(r.runId))?.report).toBe(a.won ? "a" : "b");
    expect(await files()).toEqual([`${r.runId}.result.json`]);
  }, 60_000);
});
