import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EpicError, EpicStore } from "./epic-store.js";
import { readEvents } from "./events.js";

let dir: string;
let store: EpicStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boof-epics-"));
  store = new EpicStore(dir);
});
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const code = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: EpicError) => e.code,
  );

describe("EpicStore", () => {
  it("lists no epics without a file", async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.get("x")).toBeNull();
    expect(await code(store.require("x"))).toBe("not_found");
  });

  it("derives ids from titles and skips none", async () => {
    expect((await store.create({ title: "Web hooks" })).id).toBe("web-hooks");
    expect((await store.create({ title: "Web hooks" })).id).toBe("web-hooks-2");
    expect((await store.create({ title: "None" })).id).toBe("none-2");
    expect(await code(store.create({ title: "x", id: "web-hooks" }))).toBe("exists");
    expect(await code(store.create({ title: "x", id: "none" }))).toBe("exists");
    await expect(store.create({ title: "x", id: "Not Kebab" })).rejects.toThrow();
  });

  it("orders by priority desc, updated asc, id asc and hides archived", async () => {
    await store.create({ title: "b", priority: 1 });
    await store.create({ title: "a", priority: 1 });
    await store.create({ title: "hi", priority: 5 });
    const gone = await store.create({ title: "gone", priority: 9 });
    await store.update(gone.id, { archived: true });
    const ids = (await store.list()).map((e) => e.id);
    expect(ids[0]).toBe("hi");
    expect(ids).not.toContain("gone");
    expect(ids.slice(1)).toEqual(["b", "a"]); // same priority: the older update first
    expect((await store.list({ includeArchived: true })).map((e) => e.id)[0]).toBe("gone");
  });

  it("update patches, clears the description with null and refuses a stale expectedUpdated", async () => {
    const e = await store.create({ title: "E", description: "d" });
    const u = await store.update(e.id, { title: " New ", description: null, priority: 3 });
    expect(u).toMatchObject({ title: "New", priority: 3 });
    expect(u.description).toBeUndefined();
    expect(await code(store.update(e.id, { title: "Z" }, { expectedUpdated: e.updated }))).toBe(
      "modified",
    );
    expect(await code(store.update("nope", { title: "Z" }))).toBe("not_found");
  });

  it("serializes concurrent creates", async () => {
    const made = await Promise.all(Array.from({ length: 10 }, () => store.create({ title: "E" })));
    expect(new Set(made.map((e) => e.id)).size).toBe(10);
    const file = JSON.parse(await readFile(join(dir, "epics.json"), "utf8"));
    expect(file.epics).toHaveLength(10);
  });

  it("refuses to treat a corrupt file as empty", async () => {
    await writeFile(join(dir, "epics.json"), "{ not json");
    await expect(store.list()).rejects.toThrow();
    await expect(store.create({ title: "E" })).rejects.toThrow();
    expect(await readFile(join(dir, "epics.json"), "utf8")).toBe("{ not json");
  });

  it("appends epic.updated on create, update and remove", async () => {
    const e = await store.create({ title: "E" }, { by: "me" });
    await store.update(e.id, { priority: 2 });
    await store.remove(e.id);
    const got = (await readEvents(dir, null)).map((x) => x.event);
    expect(got.map((x) => (x as { change: string }).change)).toEqual([
      "created",
      "updated",
      "deleted",
    ]);
    expect(got[0]).toMatchObject({ epic: e.id, by: "me" });
    expect(got[1]).toMatchObject({ by: "runner" });
  });

  it("remove of a missing epic is not_found", async () => {
    expect(await code(store.remove("nope"))).toBe("not_found");
  });
});
