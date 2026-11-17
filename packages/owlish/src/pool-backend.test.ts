import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InternalPoolBackend, PoolBackendError } from "./pool-backend.js";

const KEY = "sk-ant-api03-BACKENDKEYBACKEND00";
let root: string;
let backend: InternalPoolBackend;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-poolbackend-"));
  backend = new InternalPoolBackend({ root });
});
afterEach(async () => {
  await backend.stop();
  await rm(root, { recursive: true, force: true });
});

describe("InternalPoolBackend", () => {
  it("keeps accounts across a restart and never returns a key", async () => {
    const a = await backend.add({ name: "work", apiKey: KEY });
    await backend.pause(a.id);
    await backend.stop();
    const again = new InternalPoolBackend({ root });
    const list = await again.accounts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "work", paused: true });
    expect(JSON.stringify(list)).not.toContain(KEY);
    await again.stop();
  });

  it("starts the listener on the first child and stops it on stop()", async () => {
    await backend.add({ name: "work", apiKey: KEY });
    expect(await backend.port()).toBeNull();
    const g = await backend.childGateway({ runId: "r" });
    expect(g.url).toBe(`http://127.0.0.1:${await backend.port()}`);
    await backend.stop();
    await expect(fetch(g.url, { signal: AbortSignal.timeout(1000) })).rejects.toBeTruthy();
  });

  it("maps a missing account to 404 and a bad key to 400", async () => {
    await expect(backend.remove("acc-none")).rejects.toMatchObject({ status: 404 });
    const err = await backend.add({ name: "x", apiKey: "nope" }).catch((e) => e);
    expect(err).toBeInstanceOf(PoolBackendError);
    expect(err.status).toBe(400);
  });
});
