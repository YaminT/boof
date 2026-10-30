import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataRootPaths } from "@boof-runner/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpError } from "./errors.js";
import { IdempotencyStore } from "./idempotency.js";

describe("IdempotencyStore fingerprints", () => {
  it("fingerprintUpload hashes the bytes themselves, not a JSON copy", () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 0, 255]);
    const expected = createHash("sha256")
      .update("shot.png\0image/png\0")
      .update(bytes)
      .digest("hex");
    const file = { name: "shot.png", type: "image/png", bytes };
    expect(IdempotencyStore.fingerprintUpload(file, {})).toBe(
      createHash("sha256")
        .update("shot.png\0image/png\0")
        .update(bytes)
        .update("\0{}")
        .digest("hex"),
    );
    expect(IdempotencyStore.fingerprintUpload({ ...file, name: "other.png" }, {})).not.toBe(
      IdempotencyStore.fingerprintUpload(file, {}),
    );
    expect(IdempotencyStore.fingerprintUpload(file, {})).not.toBe(
      IdempotencyStore.fingerprint(file),
    );
  });

  it("fingerprintUpload covers the rest of the input: the same file for another task differs", () => {
    const file = { name: "a.png", type: "image/png", bytes: Uint8Array.from([1, 2, 3]) };
    const one = IdempotencyStore.fingerprintUpload(file, { projectId: "p", taskId: "t1" });
    expect(IdempotencyStore.fingerprintUpload(file, { projectId: "p", taskId: "t1" })).toBe(one);
    expect(IdempotencyStore.fingerprintUpload(file, { projectId: "p", taskId: "t2" })).not.toBe(
      one,
    );
  });
});

describe("IdempotencyStore.withKey", () => {
  let root: string;
  let clock: number;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "boof-idem-"));
    clock = Date.parse("2026-03-01T12:00:00Z");
  });
  afterEach(() => rm(root, { recursive: true, force: true }));
  const dir = () => dataRootPaths(root).idempotency;
  const pendingFiles = async () =>
    (await readdir(dir()).catch(() => [] as string[])).filter((n) => n.endsWith(".pending"));

  it("serializes callers of one key: the second waits and replays the first result", async () => {
    const store = new IdempotencyStore(root, () => clock);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const firstStarted = new Promise<void>((r) => (started = r));
    const order: string[] = [];
    const first = store.withKey("p", "tasks.create", "k", "fp", async () => {
      order.push("first:start");
      started();
      await gate;
      order.push("first:end");
      return { status: 201, body: { id: 1 } };
    });
    const second = store.withKey("p", "tasks.create", "k", "fp", async () => {
      order.push("second:ran");
      return { status: 201, body: { id: 2 } };
    });
    await firstStarted;
    expect(await pendingFiles()).toHaveLength(1); // the marker exists while the first runs
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.replayed).toBe(false);
    expect(a.record).toMatchObject({ status: 201, body: { id: 1 }, fingerprint: "fp" });
    expect(b).toEqual({ record: a.record, replayed: true });
    expect(order).toEqual(["first:start", "first:end"]);
    expect(await pendingFiles()).toEqual([]);
    expect(await readdir(dir())).toHaveLength(1);
  });

  it("another fingerprint on the same key is idempotency_conflict, after the first finished", async () => {
    const store = new IdempotencyStore(root, () => clock);
    const [a, b] = await Promise.allSettled([
      store.withKey("p", "tasks.create", "k", "fp-a", async () => ({ status: 201, body: 1 })),
      store.withKey("p", "tasks.create", "k", "fp-b", async () => ({ status: 201, body: 2 })),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect((b as PromiseRejectedResult).reason).toBeInstanceOf(OpError);
    expect((b as PromiseRejectedResult).reason.code).toBe("idempotency_conflict");
  });

  it("a failed execution stores nothing and frees the key for the next caller", async () => {
    const store = new IdempotencyStore(root, () => clock);
    const [a, b] = await Promise.allSettled([
      store.withKey("p", "tasks.create", "k", "fp", async () => {
        throw new OpError(400, "Invalid input", "invalid_input");
      }),
      store.withKey("p", "tasks.create", "k", "fp", async () => ({ status: 201, body: "second" })),
    ]);
    expect(a.status).toBe("rejected");
    expect(b).toMatchObject({
      status: "fulfilled",
      value: { replayed: false, record: { body: "second" } },
    });
    expect(await pendingFiles()).toEqual([]);
  });

  it("a fresh pending marker from another process is 409 conflict; a stale one is ignored", async () => {
    const store = new IdempotencyStore(root, () => clock);
    const marker = store.pendingPath("p", "tasks.create", "k");
    await mkdir(dir(), { recursive: true });
    await writeFile(marker, JSON.stringify({ fingerprint: "fp", created: clock }));
    await expect(
      store.withKey("p", "tasks.create", "k", "fp", async () => ({ status: 201, body: 1 })),
    ).rejects.toMatchObject({ code: "conflict", status: 409 });
    await writeFile(marker, JSON.stringify({ fingerprint: "fp", created: clock - 61_000 }));
    const out = await store.withKey("p", "tasks.create", "k", "fp", async () => ({
      status: 201,
      body: 1,
    }));
    expect(out.replayed).toBe(false);
    expect(await pendingFiles()).toEqual([]);
    // prune drops stale markers too.
    await writeFile(
      join(dir(), "deadbeef.pending"),
      JSON.stringify({ fingerprint: "x", created: clock - 61_000 }),
    );
    expect(await store.prune()).toBe(1);
  });

  it("re-checks the stored record after claiming: a request that finished meanwhile is replayed", async () => {
    const store = new IdempotencyStore(root, () => clock);
    await store.put("p", "tasks.create", "k", { fingerprint: "fp", status: 201, body: "first" });
    const get = vi.spyOn(store, "get");
    get.mockResolvedValueOnce(null); // the lookup before the claim missed (another process was running)
    const execute = vi.fn(async () => ({ status: 201, body: "second" }));
    const out = await store.withKey("p", "tasks.create", "k", "fp", execute);
    expect(out.replayed).toBe(true);
    expect(out.record.body).toBe("first");
    expect(execute).not.toHaveBeenCalled();
    expect(await pendingFiles()).toEqual([]);
    // With another fingerprint the same race is a conflict, not a second run.
    get.mockResolvedValueOnce(null);
    await expect(store.withKey("p", "tasks.create", "k", "fp-2", execute)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    expect(await pendingFiles()).toEqual([]);
  });

  it("removes only its own marker: a slower request never deletes the new holder's", async () => {
    const store = new IdempotencyStore(root, () => clock);
    const marker = store.pendingPath("p", "tasks.create", "k");
    const out = await store.withKey("p", "tasks.create", "k", "fp", async () => {
      // This run outlived PENDING_TTL_MS: another request took the key over.
      await rm(marker, { force: true });
      await writeFile(marker, JSON.stringify({ fingerprint: "fp", created: clock, nonce: "new" }));
      return { status: 201, body: 1 };
    });
    expect(out.replayed).toBe(false);
    expect(JSON.parse(await readFile(marker, "utf8")).nonce).toBe("new");
  });

  it("prune removes old atomicWrite temp files and keeps fresh ones", async () => {
    const store = new IdempotencyStore(root, () => Date.now() + 61_000);
    await mkdir(dir(), { recursive: true });
    await writeFile(join(dir(), ".abc.tmp"), "partial");
    expect(await store.prune()).toBe(1);
    expect(await readdir(dir())).toEqual([]);
    const fresh = new IdempotencyStore(root, () => Date.now());
    await writeFile(join(dir(), ".def.tmp"), "partial");
    expect(await fresh.prune()).toBe(0);
  });
});
