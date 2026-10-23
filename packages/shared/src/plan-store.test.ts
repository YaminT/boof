import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidIdError } from "./paths.js";
import {
  PlanExistsError,
  PlanNotFoundError,
  PlanStore,
  PlanVersionConflict,
} from "./plan-store.js";
import { testGoal as goal } from "./plan-fixtures.js";

let dir: string;
let store: PlanStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boof-plans-"));
  store = new PlanStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const input = { id: "p", title: "P", source: { kind: "api" as const } };

describe("PlanStore", () => {
  it("creates at version 1, lists and gets", async () => {
    const created = await store.create({ ...input, goals: [goal("b", 2, ["a"]), goal("a", 1)] });
    expect(created.version).toBe(1);
    expect(created.status).toBe("draft");
    expect((await store.get("p"))?.goals.map((g) => g.id)).toEqual(["a", "b"]);
    expect((await store.list()).map((p) => p.id)).toEqual(["p"]);
    expect(await store.get("nope")).toBeNull();
  });

  it("refuses to create over an existing plan and rejects bad ids", async () => {
    await store.create(input);
    await expect(store.create(input)).rejects.toBeInstanceOf(PlanExistsError);
    await expect(store.get("../x")).rejects.toBeInstanceOf(InvalidIdError);
  });

  it("save bumps version and updated, keeps created", async () => {
    const created = await store.create(input);
    const saved = await store.save({ ...created, title: "Renamed" }, { expectedVersion: 1 });
    expect(saved.version).toBe(2);
    expect(saved.created).toBe(created.created);
    expect(saved.updated >= created.updated).toBe(true);
    expect((await store.require("p")).title).toBe("Renamed");
  });

  it("throws PlanVersionConflict on a stale expectedVersion", async () => {
    const created = await store.create(input);
    await store.save({ ...created, title: "A" }, { expectedVersion: 1 });
    const err = await store
      .save({ ...created, title: "B" }, { expectedVersion: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanVersionConflict);
    expect((err as PlanVersionConflict).currentVersion).toBe(2);
    expect((err as PlanVersionConflict).expectedVersion).toBe(1);
    expect((await store.require("p")).title).toBe("A");
  });

  it("two concurrent saves from the same version: exactly one wins", async () => {
    const created = await store.create(input);
    const results = await Promise.allSettled([
      store.save({ ...created, title: "A" }, { expectedVersion: 1 }),
      store.save({ ...created, title: "B" }, { expectedVersion: 1 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await store.require("p")).version).toBe(2);
  });

  it("save of a missing plan throws PlanNotFoundError", async () => {
    const created = await store.create(input);
    await store.delete("p");
    await expect(store.save(created, { expectedVersion: 1 })).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
  });

  it("modify retries on a concurrent write unless a version is pinned", async () => {
    await store.create(input);
    const bumped = await Promise.all([
      store.modify("p", (p) => ({ ...p, description: "x" })),
      store.modify("p", (p) => ({ ...p, autoSync: true })),
    ]);
    expect(bumped).toHaveLength(2);
    const final = await store.require("p");
    expect(final.description).toBe("x");
    expect(final.autoSync).toBe(true);
    expect(final.version).toBe(3);
    await expect(store.modify("p", (p) => p, { expectedVersion: 1 })).rejects.toBeInstanceOf(
      PlanVersionConflict,
    );
  });

  it("modify writes nothing when the function changes nothing", async () => {
    await store.create(input);
    const same = await store.modify("p", (p) => p);
    expect(same.version).toBe(1);
  });

  it("skips corrupt files when listing", async () => {
    await store.create(input);
    await writeFile(join(dir, "plans", "broken.json"), "{nope", "utf8");
    expect((await store.list()).map((p) => p.id)).toEqual(["p"]);
  });
});
