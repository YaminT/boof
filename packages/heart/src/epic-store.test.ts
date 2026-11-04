import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("EpicStore validation, locking and hand edits", () => {
  const bytes = () => readFile(join(dir, "epics.json"), "utf8").catch(() => null);

  it.each([
    ["an empty title", { title: "" }],
    ["a 201-char title", { title: "x".repeat(201) }],
    ["a fractional priority", { title: "a", priority: 1.5 }],
    ["a NaN priority", { title: "a", priority: NaN }],
    ["a 20001-char description", { title: "a", description: "d".repeat(20_001) }],
  ])("create refuses %s and leaves the file untouched", async (_n, input) => {
    await store.create({ title: "keep" });
    const before = await bytes();
    await expect(store.create(input)).rejects.toThrow();
    expect(await bytes()).toBe(before);
    expect((await store.list()).map((e) => e.id)).toEqual(["keep"]);
  });

  it("update refuses an invalid patch and leaves the file untouched", async () => {
    const e = await store.create({ title: "keep" });
    const before = await bytes();
    await expect(store.update(e.id, { priority: 1.5 })).rejects.toThrow();
    await expect(store.update(e.id, { title: "" })).rejects.toThrow();
    expect(await bytes()).toBe(before);
  });

  it("serializes concurrent updates to several epics and a create", async () => {
    const made = [];
    for (let i = 0; i < 8; i++) made.push(await store.create({ title: `e${i}` }));
    await Promise.all([
      ...made.map((e, i) => store.update(e.id, { priority: i + 1 })),
      store.create({ title: "extra" }),
    ]);
    const all = await store.list();
    expect(all).toHaveLength(9);
    for (const [i, e] of made.entries()) {
      expect(all.find((x) => x.id === e.id)!.priority).toBe(i + 1);
    }
  });

  it("serializes a remove with updates and a create", async () => {
    const made = [];
    for (let i = 0; i < 6; i++) made.push(await store.create({ title: `e${i}` }));
    await Promise.all([
      store.remove(made[0].id),
      ...made.slice(1).map((e) => store.update(e.id, { priority: 7 })),
      store.create({ title: "extra" }),
    ]);
    const all = await store.list();
    expect(all.map((e) => e.id)).not.toContain(made[0].id);
    expect(all).toHaveLength(6);
    expect(all.filter((e) => e.priority === 7)).toHaveLength(5);
  });

  it("remove drops every record with that id, including hand-edited duplicates", async () => {
    const rec = (title: string) => ({
      id: "a",
      title,
      priority: 0,
      archived: false,
      created: "2026-06-04T10:00:00.000Z",
      updated: "2026-06-04T10:00:00.000Z",
    });
    await writeFile(join(dir, "epics.json"), JSON.stringify({ epics: [rec("one"), rec("two")] }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await store.remove("a");
      expect(await store.get("a")).toBeNull();
      expect(JSON.parse(await readFile(join(dir, "epics.json"), "utf8")).epics).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("two stores with differently spelled directories share one lock", async () => {
    const a = new EpicStore(dir);
    const b = new EpicStore(dir + "/");
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).create({ title: "E" })));
    expect(await store.list()).toHaveLength(10);
  });

  it("ignores duplicate ids and an epic named none with a warning, and keeps them on disk", async () => {
    const rec = (id: string, title: string) => ({
      id,
      title,
      priority: 0,
      archived: false,
      created: "2026-06-04T10:00:00.000Z",
      updated: "2026-06-04T10:00:00.000Z",
    });
    await writeFile(
      join(dir, "epics.json"),
      JSON.stringify({ epics: [rec("a", "first"), rec("a", "second"), rec("none", "n")] }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect((await store.list()).map((e) => [e.id, e.title])).toEqual([["a", "first"]]);
      expect(warn).toHaveBeenCalled();
      await store.update("a", { priority: 3 });
      const file = JSON.parse((await bytes())!);
      expect(file.epics).toHaveLength(3);
      expect(file.epics.map((e: { title: string }) => e.title)).toContain("second");
    } finally {
      warn.mockRestore();
    }
  });
});
