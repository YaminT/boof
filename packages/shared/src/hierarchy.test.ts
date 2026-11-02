import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWrite } from "./atomic.js";
import { EpicStore } from "./epic-store.js";
import { readEvents } from "./events.js";
import {
  HierarchyError,
  buildHierarchyIndex,
  createTaskInHierarchy,
  matchesHierarchy,
  moveTask,
  removeEpic,
  removeTask,
  type HierarchyErrorCode,
} from "./hierarchy.js";
import type { TaskFrontmatter } from "./schema.js";
import { TaskNotFoundError, TaskRunningError, TaskStore } from "./store.js";
import { newTask, serializeTask } from "./task-file.js";
import { taskFilePath, workingAreaDir } from "./paths.js";

let dir: string;
let other: string;
let store: TaskStore;
let epics: EpicStore;

const fm = (id: string, over: Partial<TaskFrontmatter> = {}): TaskFrontmatter => ({
  id,
  title: id,
  status: "pending",
  priority: 50,
  skip: false,
  labels: [],
  command: null,
  attachments: [],
  questions: "none",
  runs: 1,
  completedRuns: 0,
  created: "2026-06-04T10:00:00.000Z",
  updated: "2026-06-04T10:00:00.000Z",
  ...over,
});
const mk = (id: string, over: Partial<TaskFrontmatter> = {}) => newTask(fm(id, over), id);
const code = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => (e instanceof HierarchyError ? e.code : `other:${String(e)}`),
  ) as Promise<HierarchyErrorCode | string | undefined>;
const index = async () =>
  buildHierarchyIndex(await store.list(), await epics.list({ includeArchived: true }));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boof-hier-"));
  other = await mkdtemp(join(tmpdir(), "boof-hier-other-"));
  store = new TaskStore(dir);
  await store.ensureDirs();
  epics = new EpicStore(dir);
});
afterEach(async () => {
  for (const d of [dir, other]) {
    await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe("hierarchy rules", () => {
  it("creates a subtask and derives its epic from the parent", async () => {
    await epics.create({ title: "web" });
    await createTaskInHierarchy(dir, mk("p", { epicId: "web" }));
    const child = await createTaskInHierarchy(dir, mk("c", { parentId: "p" }));
    const idx = await index();
    expect(idx.info(child).epicId).toBe("web");
    expect(idx.info((await store.get("p"))!).subtasks).toEqual({ total: 1, done: 0 });
  });

  it("rejects grandchildren, both keys, unknown epic and unknown parent", async () => {
    await epics.create({ title: "web" });
    await createTaskInHierarchy(dir, mk("p"));
    await createTaskInHierarchy(dir, mk("c", { parentId: "p" }));
    expect(await code(createTaskInHierarchy(dir, mk("g", { parentId: "c" })))).toBe(
      "invalid_hierarchy",
    );
    expect(await code(createTaskInHierarchy(dir, mk("b", { parentId: "p", epicId: "web" })))).toBe(
      "invalid_hierarchy",
    );
    expect(await code(createTaskInHierarchy(dir, mk("e", { epicId: "nope" })))).toBe(
      "epic_not_found",
    );
    expect(await code(createTaskInHierarchy(dir, mk("q", { parentId: "nope" })))).toBe(
      "parent_not_found",
    );
  });

  it("resolves parents only inside the project", async () => {
    const o = new TaskStore(other);
    await o.ensureDirs();
    await o.create(mk("p"));
    expect(await code(createTaskInHierarchy(dir, mk("c", { parentId: "p" })))).toBe(
      "parent_not_found",
    );
  });

  it("orders siblings by priority desc, updated asc, id asc", async () => {
    await createTaskInHierarchy(dir, mk("p"));
    for (const [id, priority, updated] of [
      ["lo", 10, "2026-06-04T10:00:00.000Z"],
      ["b", 50, "2026-06-04T10:00:02.000Z"],
      ["a", 50, "2026-06-04T10:00:01.000Z"],
    ] as const) {
      const t = mk(id, { priority, parentId: "p" });
      await createTaskInHierarchy(dir, t);
      // create stamps `updated`; write the wanted value raw
      const got = (await store.get(id))!;
      got.frontmatter.updated = updated;
      await atomicWrite(taskFilePath(dir, "pending", id), serializeTask(got));
    }
    expect((await index()).childrenOf("p").map((t) => t.frontmatter.id)).toEqual(["a", "b", "lo"]);
  });

  it("counts progress without archived and without subtasks in epics", async () => {
    await epics.create({ title: "web" });
    await createTaskInHierarchy(dir, mk("a", { epicId: "web", status: "done" }));
    await createTaskInHierarchy(dir, mk("b", { epicId: "web" }));
    await createTaskInHierarchy(dir, mk("c", { epicId: "web", status: "archived" }));
    await createTaskInHierarchy(dir, mk("s", { parentId: "a", status: "done" }));
    expect((await index()).epicProgress("web")).toEqual({ total: 2, done: 1 });
  });

  it("index tolerates dangling refs, cycles and both keys", async () => {
    await epics.create({ title: "web" });
    const raw = async (t: ReturnType<typeof mk>) =>
      atomicWrite(taskFilePath(dir, "pending", t.frontmatter.id), serializeTask(t));
    await raw(mk("x", { parentId: "ghost" }));
    await raw(mk("y", { epicId: "gone" }));
    await raw(mk("a", { parentId: "b" }));
    await raw(mk("b", { parentId: "a" }));
    await raw(mk("p", { epicId: "web" }));
    await raw(mk("z", { parentId: "p", epicId: "gone" }));
    const idx = await index();
    const t = async (id: string) => (await store.get(id))!;
    expect(idx.info(await t("x"))).toMatchObject({ parentMissing: true });
    expect(idx.isTopLevel(await t("x"))).toBe(true);
    expect(idx.info(await t("y"))).toMatchObject({ epicMissing: true });
    expect(idx.info(await t("a"))).toBeDefined();
    expect(idx.info(await t("b"))).toBeDefined();
    expect(idx.info(await t("z")).epicId).toBe("web");
    expect(idx.info(await t("z")).epicMissing).toBeUndefined();
  });

  it("move under a parent clears epicId; parentId null detaches; epicId on a subtask is refused", async () => {
    await epics.create({ title: "web" });
    await createTaskInHierarchy(dir, mk("p"));
    await createTaskInHierarchy(dir, mk("t", { epicId: "web" }));
    await moveTask(dir, "t", { parentId: "p" });
    expect((await store.get("t"))!.frontmatter).toMatchObject({ parentId: "p" });
    expect((await store.get("t"))!.frontmatter.epicId).toBeUndefined();
    expect(await code(moveTask(dir, "t", { epicId: "web" }))).toBe("invalid_hierarchy");
    expect(await code(moveTask(dir, "t", { epicId: "web", parentId: "p" }))).toBe(
      "invalid_hierarchy",
    );
    expect(await code(moveTask(dir, "p", { parentId: "p" }))).toBe("invalid_hierarchy");
    expect(await code(moveTask(dir, "t", { parentId: "nope" }))).toBe("parent_not_found");
    await moveTask(dir, "t", { parentId: null, epicId: "web" });
    expect((await store.get("t"))!.frontmatter).toMatchObject({ epicId: "web" });
    expect((await store.get("t"))!.frontmatter.parentId).toBeUndefined();
    await moveTask(dir, "t", { epicId: null });
    expect((await store.get("t"))!.frontmatter.epicId).toBeUndefined();
    expect(await code(moveTask(dir, "t", { epicId: "nope" }))).toBe("epic_not_found");
    await expect(moveTask(dir, "ghost", { epicId: null })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });

  it("refuses to move a task with subtasks under a parent, or under a subtask", async () => {
    await createTaskInHierarchy(dir, mk("p"));
    await createTaskInHierarchy(dir, mk("c", { parentId: "p" }));
    await createTaskInHierarchy(dir, mk("q"));
    expect(await code(moveTask(dir, "p", { parentId: "q" }))).toBe("has_children");
    expect(await code(moveTask(dir, "q", { parentId: "c" }))).toBe("invalid_hierarchy");
  });

  it("move appends task.moved with from and to; a no-op move appends nothing", async () => {
    await epics.create({ title: "web" });
    await createTaskInHierarchy(dir, mk("t"));
    await moveTask(dir, "t", { epicId: "web" }, { by: "me" });
    await moveTask(dir, "t", { epicId: "web" });
    const moved = (await readEvents(dir, null))
      .map((e) => e.event)
      .filter((e) => e.type === "task.moved");
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      task: "t",
      from: { epicId: null, parentId: null },
      to: { epicId: "web", parentId: null },
      by: "me",
    });
  });

  it("removeTask refuses with children and detaches into the parent's epic", async () => {
    await epics.create({ title: "web" });
    await createTaskInHierarchy(dir, mk("p", { epicId: "web" }));
    await createTaskInHierarchy(dir, mk("c", { parentId: "p" }));
    expect(await code(removeTask(dir, "p"))).toBe("has_children");
    expect(await removeTask(dir, "p", { detach: true })).toEqual({ detached: ["c"] });
    expect(await store.get("p")).toBeNull();
    expect((await store.get("c"))!.frontmatter).toMatchObject({ epicId: "web" });
    expect((await store.get("c"))!.frontmatter.parentId).toBeUndefined();
  });

  it("removeEpic refuses with tasks, detach clears epicId on every status", async () => {
    await epics.create({ title: "web" });
    await createTaskInHierarchy(dir, mk("a", { epicId: "web" }));
    await createTaskInHierarchy(dir, mk("b", { epicId: "web", status: "archived" }));
    expect(await code(removeEpic(dir, "web"))).toBe("has_tasks");
    expect(await code(removeEpic(dir, "nope"))).toBe("epic_not_found");
    const res = await removeEpic(dir, "web", { detach: true });
    expect(res.detached.sort()).toEqual(["a", "b"]);
    expect(await epics.get("web")).toBeNull();
    expect((await store.get("b"))!.frontmatter.epicId).toBeUndefined();
  });

  it("removeEpic --detach lets other hierarchy operations in between its batches", async () => {
    await epics.create({ title: "web" });
    for (let i = 0; i < 7; i++) await createTaskInHierarchy(dir, mk(`m${i}`, { epicId: "web" }));
    await createTaskInHierarchy(dir, mk("loose"));
    const order: string[] = [];
    const removing = removeEpic(dir, "web", { detach: true, batch: 2 }).then((r) => {
      order.push("removed");
      return r;
    });
    const moving = moveTask(dir, "loose", { epicId: null }).then(() => order.push("moved"));
    const [res] = await Promise.all([removing, moving]);
    // A long detach does not hold the lock for the whole epic (one pid lock, 30 s waits).
    expect(order).toEqual(["moved", "removed"]);
    expect(res.detached.sort()).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(await epics.get("web")).toBeNull();
    for (let i = 0; i < 7; i++)
      expect((await store.get(`m${i}`))!.frontmatter.epicId).toBeUndefined();
  });

  it("removeEpic batches also take a task that joined the epic between batches", async () => {
    await epics.create({ title: "web" });
    for (let i = 0; i < 4; i++) await createTaskInHierarchy(dir, mk(`m${i}`, { epicId: "web" }));
    const removing = removeEpic(dir, "web", { detach: true, batch: 2 });
    const joining = createTaskInHierarchy(dir, mk("late", { epicId: "web" })).catch((e) => e);
    const [res, late] = await Promise.all([removing, joining]);
    const left = (await store.list()).filter((t) => t.frontmatter.epicId === "web");
    expect(left).toEqual([]); // never a task naming the removed epic
    if (!(late instanceof Error)) expect(res.detached).toContain("late");
  });

  it("filters by epic and parent", async () => {
    await epics.create({ title: "web" });
    await createTaskInHierarchy(dir, mk("p", { epicId: "web" }));
    await createTaskInHierarchy(dir, mk("c", { parentId: "p" }));
    await createTaskInHierarchy(dir, mk("free"));
    await atomicWrite(
      taskFilePath(dir, "pending", "x"),
      serializeTask(mk("x", { parentId: "ghost" })),
    );
    const idx = await index();
    const ids = async (f: Parameters<typeof matchesHierarchy>[2]) =>
      (await store.list())
        .filter((t) => matchesHierarchy(t, idx, f))
        .map((t) => t.frontmatter.id)
        .sort();
    expect(await ids({ epic: "web" })).toEqual(["c", "p"]);
    expect(await ids({ epic: "none" })).toEqual(["free", "x"]);
    expect(await ids({ parent: "p" })).toEqual(["c"]);
    expect(await ids({ parent: "none" })).toEqual(["free", "p", "x"]);
  });
});

describe("hierarchy and a corrupt epics.json", () => {
  it("reads epics only for the operations that need them", async () => {
    await createTaskInHierarchy(dir, mk("p"));
    await createTaskInHierarchy(dir, mk("a"));
    await createTaskInHierarchy(dir, mk("b"));
    await writeFile(join(dir, "epics.json"), "{ not json");
    await moveTask(dir, "a", { parentId: "p" });
    await createTaskInHierarchy(dir, mk("c", { parentId: "p" }));
    await removeTask(dir, "b");
    expect(await store.get("b")).toBeNull();
    // The epic paths fail loudly: the file is never read as empty.
    await expect(createTaskInHierarchy(dir, mk("d", { epicId: "web" }))).rejects.toThrow();
    await expect(moveTask(dir, "c", { epicId: "web" })).rejects.toThrow();
    await expect(removeEpic(dir, "web")).rejects.toThrow();
  });
});

describe("hierarchy detach details", () => {
  const raw = (t: ReturnType<typeof mk>) =>
    atomicWrite(taskFilePath(dir, "pending", t.frontmatter.id), serializeTask(t));

  it("detaching a child that stores both keys drops its stale epic and reports from/to", async () => {
    await epics.create({ title: "old" });
    await raw(mk("p"));
    await raw(mk("c", { parentId: "p", epicId: "old" }));
    await removeTask(dir, "p", { detach: true });
    expect((await store.get("c"))!.frontmatter.epicId).toBeUndefined();
    const ev = (await readEvents(dir, null))
      .map((e) => e.event)
      .find((e) => e.type === "task.moved");
    expect(ev).toMatchObject({
      task: "c",
      from: { epicId: "old", parentId: "p" },
      to: { epicId: null, parentId: null },
    });
  });

  it("skips a child that vanished mid-detach", async () => {
    await createTaskInHierarchy(dir, mk("p"));
    await createTaskInHierarchy(dir, mk("c1", { parentId: "p" }));
    await createTaskInHierarchy(dir, mk("c2", { parentId: "p" }));
    const real = TaskStore.prototype.modify;
    const spy = vi.spyOn(TaskStore.prototype, "modify").mockImplementation(async function (
      this: TaskStore,
      id,
      fn,
    ) {
      if (id === "c1") await this.delete("c1");
      return real.call(this, id, fn);
    });
    try {
      const res = await removeTask(dir, "p", { detach: true });
      expect(res.detached).toEqual(["c2"]);
    } finally {
      spy.mockRestore();
    }
    expect(await store.get("p")).toBeNull();
  });

  it("removeTask on a missing id throws TaskNotFoundError", async () => {
    await expect(removeTask(dir, "ghost")).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it("removeTask refuses a running task and leaves its children alone", async () => {
    await createTaskInHierarchy(dir, mk("p"));
    await createTaskInHierarchy(dir, mk("c", { parentId: "p" }));
    await store.transition("p", "running");
    await expect(removeTask(dir, "p", { detach: true })).rejects.toBeInstanceOf(TaskRunningError);
    expect((await store.get("c"))!.frontmatter.parentId).toBe("p");
    expect(await store.get("p")).not.toBeNull();
  });

  it("removeTask re-checks under the task lock: a task started after the scan is not deleted", async () => {
    await createTaskInHierarchy(dir, mk("p"));
    const real = TaskStore.prototype.list;
    let armed = true;
    const spy = vi.spyOn(TaskStore.prototype, "list").mockImplementation(async function (
      this: TaskStore,
    ) {
      const out = await real.call(this);
      if (armed) {
        armed = false;
        await store.transition("p", "running"); // the scheduler starts it after the scan
      }
      return out;
    });
    try {
      await expect(removeTask(dir, "p")).rejects.toBeInstanceOf(TaskRunningError);
    } finally {
      spy.mockRestore();
    }
    expect((await store.get("p"))!.frontmatter.status).toBe("running");
  });

  it("childrenOf returns a copy", async () => {
    await createTaskInHierarchy(dir, mk("p"));
    await createTaskInHierarchy(dir, mk("c", { parentId: "p" }));
    const idx = await index();
    idx.childrenOf("p").length = 0;
    expect(idx.childrenOf("p")).toHaveLength(1);
  });
});

describe("hierarchy concurrency", () => {
  const stored = async () => (await store.list()).map((t) => t.frontmatter);

  it("epic deleted while a task is created into it", async () => {
    for (let i = 0; i < 20; i++) {
      await rm(join(dir, "epics.json"), { force: true });
      for (const t of await store.list()) await store.delete(t.frontmatter.id);
      await epics.create({ title: "e" });
      const create = () => createTaskInHierarchy(dir, mk("t", { epicId: "e" }));
      const [c, r] =
        i % 2 === 0
          ? await Promise.allSettled([create(), removeEpic(dir, "e")])
          : (await Promise.allSettled([removeEpic(dir, "e"), create()])).reverse();
      const createdOk = c.status === "fulfilled";
      const removedOk = r.status === "fulfilled";
      expect(createdOk !== removedOk).toBe(true);
      if (!createdOk) expect((c as PromiseRejectedResult).reason.code).toBe("epic_not_found");
      else expect((r as PromiseRejectedResult).reason.code).toBe("has_tasks");
      for (const f of await stored())
        if (f.epicId) expect(await epics.get(f.epicId)).not.toBeNull();
    }
  });

  it("parent deleted while a subtask is created", async () => {
    for (let i = 0; i < 20; i++) {
      for (const t of await store.list()) await store.delete(t.frontmatter.id);
      await createTaskInHierarchy(dir, mk("p"));
      const create = () => createTaskInHierarchy(dir, mk("c", { parentId: "p" }));
      const [c, r] =
        i % 2 === 0
          ? await Promise.allSettled([create(), removeTask(dir, "p")])
          : (await Promise.allSettled([removeTask(dir, "p"), create()])).reverse();
      const createdOk = c.status === "fulfilled";
      const removedOk = r.status === "fulfilled";
      expect(createdOk !== removedOk).toBe(true);
      if (!createdOk) expect((c as PromiseRejectedResult).reason.code).toBe("parent_not_found");
      else expect((r as PromiseRejectedResult).reason.code).toBe("has_children");
    }
  });

  it("two crossing moves never make a grandchild", async () => {
    for (let i = 0; i < 10; i++) {
      for (const t of await store.list()) await store.delete(t.frontmatter.id);
      await createTaskInHierarchy(dir, mk("a"));
      await createTaskInHierarchy(dir, mk("b"));
      const ab = () => moveTask(dir, "a", { parentId: "b" });
      const ba = () => moveTask(dir, "b", { parentId: "a" });
      const res = await Promise.allSettled(i % 2 === 0 ? [ab(), ba()] : [ba(), ab()]);
      expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const all = await stored();
      for (const f of all) {
        if (f.parentId) expect(all.find((x) => x.id === f.parentId)!.parentId).toBeUndefined();
      }
    }
  });

  // The three tests below act between the directory reads of TaskStore.list() with a spy on its
  // private methods, so each guard of the settling scan fails on its own, deterministically.
  const priv = TaskStore.prototype as unknown as Record<
    string,
    (...a: unknown[]) => Promise<unknown>
  >;

  it("a child that moves to an earlier directory mid-scan is still seen by the rules", async () => {
    await createTaskInHierarchy(dir, mk("p"));
    await createTaskInHierarchy(dir, mk("q"));
    await createTaskInHierarchy(dir, mk("c", { parentId: "p" }));
    await store.transition("c", "running");
    const real = priv.listStatus;
    let armed = true;
    const spy = vi.spyOn(priv, "listStatus").mockImplementation(async function (
      this: TaskStore,
      status: unknown,
      names: unknown,
    ) {
      if (status === "running" && armed) {
        armed = false;
        await store.transition("c", "pending"); // pending was already read without c
      }
      return real.call(this, status, names);
    });
    try {
      expect(await code(removeTask(dir, "p"))).toBe("has_children");
      await store.transition("c", "running");
      armed = true;
      expect(await code(moveTask(dir, "p", { parentId: "q" }))).toBe("has_children");
    } finally {
      spy.mockRestore();
    }
    const all = await store.list();
    expect(all.find((t) => t.frontmatter.id === "p")).toBeDefined();
    expect(all.find((t) => t.frontmatter.id === "p")!.frontmatter.parentId).toBeUndefined();
  });

  it("list() repeats a scan that overlapped a status move in this process", async () => {
    await createTaskInHierarchy(dir, mk("c"));
    await store.transition("c", "running");
    const real = priv.listStatusNames;
    let step = 0;
    const spy = vi.spyOn(priv, "listStatusNames").mockImplementation(async function (
      this: TaskStore,
      status: unknown,
      into: unknown,
    ) {
      const out = await real.call(this, status, into);
      if (step === 0 && status === "running") {
        step = 1; // the name was read; the file read will find nothing
        await store.transition("c", "pending");
      } else if (step === 1 && status === "action") {
        step = 2; // back before the fresh name listing, which now matches the scan's names
        await store.transition("c", "running");
      }
      return out;
    });
    try {
      expect((await store.list()).map((t) => t.frontmatter.id)).toEqual(["c"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("list() repeats a scan when another process moved a file (names differ, no counter)", async () => {
    await createTaskInHierarchy(dir, mk("c"));
    await store.transition("c", "running");
    const real = priv.listStatus;
    let armed = true;
    const spy = vi.spyOn(priv, "listStatus").mockImplementation(async function (
      this: TaskStore,
      status: unknown,
      names: unknown,
    ) {
      if (status === "running" && armed) {
        armed = false;
        // As the CLI would: write the destination, remove the source, bypass TaskStore.
        const task = (await store.get("c"))!;
        task.frontmatter.status = "pending";
        await atomicWrite(taskFilePath(dir, "pending", "c"), serializeTask(task));
        await rm(workingAreaDir(dir, "c"), { recursive: true, force: true });
      }
      return real.call(this, status, names);
    });
    try {
      expect((await store.list()).map((t) => t.frontmatter.id)).toEqual(["c"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("an unsettled list() drops a task deleted meanwhile and reports true statuses", async () => {
    await createTaskInHierarchy(dir, mk("c"));
    await createTaskInHierarchy(dir, mk("d"));
    await createTaskInHierarchy(dir, mk("e"));
    const real = priv.listNames;
    let calls = 0;
    const spy = vi.spyOn(priv, "listNames").mockImplementation(async function (this: TaskStore) {
      calls++;
      if (calls === 2) await store.delete("d");
      if (calls === 3) await store.transition("e", "running");
      const out = (await real.call(this)) as Set<string>;
      out.add(`bogus/${calls}`); // never matches: every round is unsettled
      return out;
    });
    try {
      const got = await store.list();
      expect(got.map((t) => `${t.frontmatter.id}:${t.frontmatter.status}`).sort()).toEqual([
        "c:pending",
        "e:running",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(!process.env.BOOF_SOAK)(
    "soak: a child flipping between status directories never hides from the rules",
    async () => {
      for (let i = 0; i < 60; i++) await store.create(mk(`filler-${i}`));
      await createTaskInHierarchy(dir, mk("p"));
      await createTaskInHierarchy(dir, mk("q"));
      await createTaskInHierarchy(dir, mk("c", { parentId: "p" }));
      let stop = false;
      const flipper = (async () => {
        while (!stop) {
          await store.transition("c", "running");
          await store.transition("c", "pending");
        }
      })();
      try {
        for (let i = 0; i < 25; i++) {
          expect(await code(removeTask(dir, "p"))).toBe("has_children");
          expect(await code(moveTask(dir, "p", { parentId: "q" }))).toBe("has_children");
        }
      } finally {
        stop = true;
        await flipper;
      }
      const all = await stored();
      expect(all.find((f) => f.id === "p")).toBeDefined();
      expect(all.find((f) => f.id === "p")!.parentId).toBeUndefined();
    },
    60_000,
  );

  it("a move while the task runs survives save and transition", async () => {
    await epics.create({ title: "web" });
    await createTaskInHierarchy(dir, mk("t"));
    await store.transition("t", "running");
    const stale = (await store.get("t"))!;
    await moveTask(dir, "t", { epicId: "web" });
    await store.save(stale);
    await store.transition("t", "done");
    expect((await store.get("t"))!.frontmatter.epicId).toBe("web");
  });
});
