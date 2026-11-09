import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dataRootPaths } from "./paths.js";
import { EXTERNAL_RUN_ID, EXTERNAL_RUN_TOKEN_PREFIX, ExternalRunStore } from "./external-runs.js";

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
  });

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
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, `${r.runId}.json`))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, `${done.runId}.result.json`))).mode & 0o777).toBe(0o600);
  });
});
