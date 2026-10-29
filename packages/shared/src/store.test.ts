import { mkdtemp, rm, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidTransitionError } from "./lifecycle.js";
import {
  appendInjectedEntry,
  readTaskIfExists,
  TaskExistsError,
  TaskNotFoundError,
  TaskNotRunningError,
  TaskStore,
} from "./store.js";
import { newTask, serializeTask } from "./task-file.js";
import { parseInjected } from "./injected.js";
import { ALL_STATUSES, statusDir, taskFilePath, workingAreaDir } from "./paths.js";
import type { TaskFrontmatter } from "./schema.js";

let root: string;
let store: TaskStore;

const fm = (over: Partial<TaskFrontmatter> = {}): TaskFrontmatter => ({
  id: "t1",
  title: "T1",
  status: "pending",
  priority: 50,
  skip: false,
  labels: [],
  command: null,
  attachments: [],
  questions: "none",
  created: "2026-06-04T10:00:00.000Z",
  updated: "2026-06-04T10:00:00.000Z",
  ...over,
});

const fileExists = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-store-"));
  store = new TaskStore(root);
  await store.ensureDirs();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("TaskStore", () => {
  it("creates a task in the directory matching its status", async () => {
    await store.create(newTask(fm()));
    expect(await fileExists(taskFilePath(root, "pending", "t1"))).toBe(true);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].frontmatter.id).toBe("t1");
  });

  it("moves the file on a valid transition (write-then-move)", async () => {
    await store.create(newTask(fm()));
    await store.transition("t1", "running");
    expect(await fileExists(taskFilePath(root, "pending", "t1"))).toBe(false);
    expect(await fileExists(taskFilePath(root, "running", "t1"))).toBe(true);
    const t = await store.get("t1");
    expect(t?.frontmatter.status).toBe("running");
  });

  it("rejects an invalid transition", async () => {
    await store.create(newTask(fm({ status: "done" })));
    await expect(store.transition("t1", "running")).rejects.toThrow();
  });

  it("preserves created and refreshes updated on save", async () => {
    const t = await store.create(newTask(fm({ created: "2026-01-01T00:00:00.000Z" })));
    const before = t.frontmatter.updated;
    await new Promise((r) => setTimeout(r, 5));
    const saved = await store.save(t);
    expect(saved.frontmatter.created).toBe("2026-01-01T00:00:00.000Z");
    expect(saved.frontmatter.updated).not.toBe(before);
  });

  it("reconciles status to the directory it is found in", async () => {
    // Write a file into pending/ whose frontmatter claims draft.
    const t = newTask(fm({ status: "draft" }));
    const raw = (await import("./task-file.js")).serializeTask(t);
    await mkdir(statusDir(root, "pending"), { recursive: true });
    await writeFile(taskFilePath(root, "pending", "t1"), raw, "utf8");

    const got = await store.get("t1");
    expect(got?.frontmatter.status).toBe("pending"); // location wins
  });

  it("toggles skip without changing status or location", async () => {
    await store.create(newTask(fm()));
    await store.setSkip("t1", true);
    const t = await store.get("t1");
    expect(t?.frontmatter.skip).toBe(true);
    expect(t?.frontmatter.status).toBe("pending");
    expect(await fileExists(taskFilePath(root, "pending", "t1"))).toBe(true);
  });

  it("readTaskIfExists returns null for a file removed after it was listed", async () => {
    await store.create(newTask(fm()));
    const path = taskFilePath(root, "pending", "t1");
    await rm(path);
    expect(await readTaskIfExists(path, "pending")).toBeNull();
  });

  it("readTaskIfExists rethrows errors other than ENOENT", async () => {
    const dirPath = join(statusDir(root, "pending"), "not-a-file.md");
    await mkdir(dirPath, { recursive: true });
    await expect(readTaskIfExists(dirPath, "pending")).rejects.toThrow();
  });

  it("list() reports a task present in pending/ and ongoing/ once, keeping the newer updated", async () => {
    const older = newTask(fm({ status: "pending", updated: "2026-06-04T10:00:00.000Z" }));
    const newer = newTask(fm({ status: "running", updated: "2026-06-04T11:00:00.000Z" }));
    await writeFile(taskFilePath(root, "pending", "t1"), serializeTask(older), "utf8");
    await mkdir(workingAreaDir(root, "t1"), { recursive: true });
    await writeFile(taskFilePath(root, "running", "t1"), serializeTask(newer), "utf8");

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].frontmatter.id).toBe("t1");
    expect(list[0].frontmatter.status).toBe("running");
    expect(list[0].frontmatter.updated).toBe("2026-06-04T11:00:00.000Z");
  });

  it("list() keeps the older-directory copy when it has the newer updated", async () => {
    const pendingNewer = newTask(fm({ status: "pending", updated: "2026-06-04T12:00:00.000Z" }));
    const runningOlder = newTask(fm({ status: "running", updated: "2026-06-04T09:00:00.000Z" }));
    await writeFile(taskFilePath(root, "pending", "t1"), serializeTask(pendingNewer), "utf8");
    await mkdir(workingAreaDir(root, "t1"), { recursive: true });
    await writeFile(taskFilePath(root, "running", "t1"), serializeTask(runningOlder), "utf8");

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].frontmatter.status).toBe("pending");
    expect(list[0].frontmatter.updated).toBe("2026-06-04T12:00:00.000Z");
  });

  it("get() retries locate once when the located file moved before it was read", async () => {
    await store.create(newTask(fm()));
    const stale = { status: "pending" as const, path: taskFilePath(root, "pending", "t1") };
    await store.transition("t1", "running");

    const spy = vi.spyOn(store, "locate").mockResolvedValueOnce(stale);
    try {
      const t = await store.get("t1");
      expect(t?.frontmatter.id).toBe("t1");
      expect(t?.frontmatter.status).toBe("running");
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("get() returns null when the task is still missing after the retry", async () => {
    await store.create(newTask(fm()));
    const stale = { status: "pending" as const, path: taskFilePath(root, "pending", "t1") };
    await rm(stale.path);

    const spy = vi.spyOn(store, "locate").mockResolvedValue(stale);
    try {
      expect(await store.get("t1")).toBeNull();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("TaskStore stopped and injected", () => {
  it("creates the stopped directory and moves running, stopped, pending", async () => {
    expect(await fileExists(statusDir(root, "stopped"))).toBe(true);
    await store.create(newTask(fm({ status: "running" })));
    await store.transition("t1", "stopped");
    expect(await fileExists(taskFilePath(root, "stopped", "t1"))).toBe(true);
    expect((await store.get("t1"))?.frontmatter.status).toBe("stopped");
    await store.transition("t1", "pending");
    expect(await fileExists(taskFilePath(root, "stopped", "t1"))).toBe(false);
  });

  it("keeps injected prompts through save, transition and leaving running", async () => {
    await store.create(newTask(fm({ status: "running" }), "p"));
    const stale = (await store.get("t1"))!;
    await store.appendInjected("t1", "first", "alice");
    await store.appendInjected("t1", "second");
    // A save from a copy read before the injections must not drop them.
    stale.body.log = "late log";
    await store.save(stale);
    const mid = (await store.get("t1"))!;
    expect(mid.body.log).toBe("late log");
    expect(parseInjected(mid.body.injected).map((e) => [e.by, e.text])).toEqual([
      ["alice", "first"],
      ["user", "second"],
    ]);
    await store.transition("t1", "stopped");
    const after = (await store.get("t1"))!;
    expect(after.body.injected).toBe(mid.body.injected);
  });

  it("records the inject mode and stamps when entries were applied", async () => {
    await store.create(newTask(fm({ status: "running" }), "p"));
    await store.appendInjected("t1", "now please", "user", "now");
    await store.markInjectedApplied("t1", "2026-06-04T10:00:00.000Z");
    await store.appendInjected("t1", "later", "user", "next-step");
    await store.markInjectedApplied("t1", "2026-06-04T11:00:00.000Z");
    const entries = parseInjected((await store.get("t1"))!.body.injected);
    expect(entries.map((e) => [e.text, e.mode, e.appliedAt])).toEqual([
      ["now please", "now", "2026-06-04T10:00:00.000Z"],
      ["later", "next-step", "2026-06-04T11:00:00.000Z"],
    ]);
  });
});

void readFile;

describe("TaskStore modify", () => {
  it("modify re-reads the file so it keeps fields changed since the caller's copy", async () => {
    await store.create(newTask(fm()));
    const edited = (await store.get("t1"))!;
    edited.frontmatter.labels = ["edited"];
    edited.frontmatter.runs = 3;
    await store.save(edited);
    const usage = { inputTokens: 10, outputTokens: 5, costUsd: 0.5, known: true };
    const out = await store.modify("t1", (t) => {
      t.frontmatter.tokens = usage;
    });
    expect(out.frontmatter.labels).toEqual(["edited"]);
    expect(out.frontmatter.runs).toBe(3);
    const disk = (await store.get("t1"))!;
    expect(disk.frontmatter.tokens).toEqual(usage);
    expect(disk.frontmatter.labels).toEqual(["edited"]);
    await expect(store.modify("ghost", () => {})).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it("rejects an async mutate in modify and transition, and writes nothing", async () => {
    await store.create(newTask(fm()));
    const asyncMutate = (async (t: { frontmatter: { labels: string[] } }) => {
      t.frontmatter.labels = ["lost"];
    }) as unknown as (t: never) => void;
    await expect(store.modify("t1", asyncMutate)).rejects.toThrow(TypeError);
    await expect(store.modify("t1", asyncMutate)).rejects.toThrow(/synchronous/);
    await expect(store.transition("t1", "running", asyncMutate)).rejects.toThrow(TypeError);
    const disk = (await store.get("t1"))!;
    expect(disk.frontmatter.labels).toEqual([]);
    expect(disk.frontmatter.status).toBe("pending");
    // the lock was released
    await store.modify("t1", (t) => {
      t.frontmatter.labels = ["ok"];
    });
  });
});

describe("TaskStore whileRunning (control files)", () => {
  it("refuses a task that is not running and creates no working area", async () => {
    await store.create(newTask(fm({ status: "done" })));
    await expect(store.whileRunning("t1", async () => {})).rejects.toBeInstanceOf(
      TaskNotRunningError,
    );
    expect(await fileExists(workingAreaDir(root, "t1"))).toBe(false);
    await expect(store.whileRunning("nope", async () => {})).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });

  it("holds the task lock: a transition out of running waits for the control write", async () => {
    await store.create(newTask(fm({ status: "running" })));
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const control = store.whileRunning("t1", async ({ controlDir }) => {
      entered();
      await gate;
      await writeFile(join(controlDir, "stop"), "now\n");
      order.push("control");
    });
    await inside;
    const leave = store.transition("t1", "done").then(() => order.push("transition"));
    // Give the transition every chance to overtake: it must still be queued behind the gate.
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    expect(order).toEqual([]);
    expect((await store.get("t1"))?.frontmatter.status).toBe("running");
    release();
    await Promise.all([control, leave]);
    expect(order).toEqual(["control", "transition"]);
    expect(await fileExists(workingAreaDir(root, "t1"))).toBe(false);
    await expect(store.whileRunning("t1", async () => {})).rejects.toBeInstanceOf(
      TaskNotRunningError,
    );
  });

  it("applies mutate in the same critical section", async () => {
    await store.create(newTask(fm({ status: "running" }), "p"));
    const t = await store.whileRunning(
      "t1",
      async () => {},
      (task) => appendInjectedEntry(task, { text: "go", by: "alice", mode: "now" }),
    );
    expect(parseInjected(t.body.injected).map((e) => [e.by, e.text, e.mode])).toEqual([
      ["alice", "go", "now"],
    ]);
    expect(parseInjected((await store.get("t1"))!.body.injected)).toHaveLength(1);
  });

  it("clears stale control files when a task enters running", async () => {
    await store.create(newTask(fm({ status: "pending" })));
    await mkdir(join(workingAreaDir(root, "t1"), "control"), { recursive: true });
    await writeFile(join(workingAreaDir(root, "t1"), "control", "stop"), "stale\n");
    await store.transition("t1", "running");
    expect(await fileExists(join(workingAreaDir(root, "t1"), "control"))).toBe(false);
    expect((await store.get("t1"))?.frontmatter.status).toBe("running");
  });
});

describe("TaskStore timings", () => {
  it("sets startedAt and empties steps when a task enters running", async () => {
    await store.create(newTask(fm({ steps: [{ label: "Old", at: "2026-06-01T00:00:00.000Z" }] })));
    const before = Date.now();
    const t = await store.transition("t1", "running");
    expect(t.frontmatter.startedAt).toBeDefined();
    expect(Date.parse(t.frontmatter.startedAt!)).toBeGreaterThanOrEqual(before);
    expect(t.frontmatter.steps).toEqual([]);
    const disk = (await store.get("t1"))!;
    expect(disk.frontmatter.startedAt).toBe(t.frontmatter.startedAt);
    expect(disk.frontmatter.steps).toEqual([]);
  });

  it("keeps startedAt when the task leaves running", async () => {
    await store.create(newTask(fm()));
    const run = await store.transition("t1", "running");
    await store.transition("t1", "done");
    expect((await store.get("t1"))!.frontmatter.startedAt).toBe(run.frontmatter.startedAt);
  });

  it("appendStep adds labels in order", async () => {
    await store.create(newTask(fm()));
    await store.transition("t1", "running");
    await store.appendStep("t1", "Planner", "2026-06-04T10:00:01.000Z");
    await store.appendStep("t1", "Developer", "2026-06-04T10:00:02.000Z");
    expect((await store.get("t1"))!.frontmatter.steps).toEqual([
      { label: "Planner", at: "2026-06-04T10:00:01.000Z" },
      { label: "Developer", at: "2026-06-04T10:00:02.000Z" },
    ]);
  });

  it("save does not drop steps appended since the copy was read", async () => {
    await store.create(newTask(fm()));
    await store.transition("t1", "running");
    const stale = (await store.get("t1"))!;
    await store.appendStep("t1", "Planner", "2026-06-04T10:00:01.000Z");
    await store.save(stale);
    const disk = (await store.get("t1"))!;
    expect(disk.frontmatter.steps).toEqual([{ label: "Planner", at: "2026-06-04T10:00:01.000Z" }]);
    expect(disk.frontmatter.startedAt).toBeDefined();
  });

  it("appendStep on a missing task is a no-op", async () => {
    await expect(store.appendStep("nope", "Planner")).resolves.toBeUndefined();
  });
});

describe("TaskStore races", () => {
  const copies = async (id: string) => {
    let n = 0;
    for (const s of ALL_STATUSES) if (await fileExists(taskFilePath(root, s, id))) n += 1;
    return n;
  };

  it("two claims of one pending task: one wins, one gets InvalidTransitionError, one file remains", async () => {
    await store.create(newTask(fm()));
    const results = await Promise.allSettled([
      store.transition("t1", "running"),
      store.transition("t1", "running"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(InvalidTransitionError);
    expect(await copies("t1")).toBe(1);
    expect((await store.locate("t1"))!.status).toBe("running");
  });

  it("archive racing a claim leaves the task in exactly one directory", async () => {
    await store.create(newTask(fm()));
    const results = await Promise.allSettled([
      store.transition("t1", "archived"),
      store.transition("t1", "running"),
    ]);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(InvalidTransitionError);
    expect(await copies("t1")).toBe(1);
    expect(await fileExists(taskFilePath(root, "pending", "t1"))).toBe(false);
  });

  it("a save racing pending→running does not recreate the pending file", async () => {
    await store.create(newTask(fm()));
    const stale = (await store.get("t1"))!;
    stale.frontmatter.priority = 1;
    await Promise.all([store.transition("t1", "running"), store.save(stale)]);
    expect(await fileExists(taskFilePath(root, "pending", "t1"))).toBe(false);
    const disk = (await store.get("t1"))!;
    expect(disk.frontmatter.status).toBe("running");
    expect(await copies("t1")).toBe(1);
  });

  it("a save issued while the claim is mid-flight does not recreate the pending file", async () => {
    await store.create(newTask(fm()));
    const stale = (await store.get("t1"))!;
    const claim = store.transition("t1", "running");
    // Wait for the real condition: the destination is on disk, the source not yet removed.
    while (!(await fileExists(taskFilePath(root, "running", "t1")))) await Promise.resolve();
    const saved = store.save(stale);
    await Promise.all([claim, saved]);
    expect(await fileExists(taskFilePath(root, "pending", "t1"))).toBe(false);
    expect(await copies("t1")).toBe(1);
  });

  it("save writes at the task's current location when the in-memory status is stale", async () => {
    await store.create(newTask(fm()));
    const stale = (await store.get("t1"))!;
    await store.transition("t1", "running");
    stale.frontmatter.title = "Renamed";
    const saved = await store.save(stale);
    expect(saved.frontmatter.status).toBe("running");
    expect((await store.get("t1"))!.frontmatter.title).toBe("Renamed");
    expect(await fileExists(taskFilePath(root, "pending", "t1"))).toBe(false);
  });

  it("save throws TaskNotFoundError for a task that is gone", async () => {
    await store.create(newTask(fm()));
    const copy = (await store.get("t1"))!;
    await store.delete("t1");
    await expect(store.save(copy)).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(await copies("t1")).toBe(0);
  });

  it("createUnique gives concurrent creates of one title different ids", async () => {
    const mk = () => newTask(fm({ id: "x", title: "Same title" }));
    const made = await Promise.all([store.createUnique(mk()), store.createUnique(mk())]);
    const ids = made.map((t) => t.frontmatter.id);
    expect(new Set(ids).size).toBe(2);
    expect((await store.list()).length).toBe(2);
  });

  it("create refuses an id that exists in any status directory", async () => {
    await store.create(newTask(fm()));
    await expect(store.create(newTask(fm({ status: "draft" })))).rejects.toBeInstanceOf(
      TaskExistsError,
    );
    expect(await copies("t1")).toBe(1);
    const results = await Promise.allSettled([
      store.create(newTask(fm({ id: "t2" }))),
      store.create(newTask(fm({ id: "t2" }))),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await copies("t2")).toBe(1);
  });
});
