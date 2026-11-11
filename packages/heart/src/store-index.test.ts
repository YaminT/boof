import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusDir, taskFilePath, workingAreaDir } from "./paths.js";
import type { Status, TaskFrontmatter } from "./schema.js";
import { takeTaskFileReads, takeTaskStatCalls, TaskStore } from "./store.js";
import { newTask, serializeTask } from "./task-file.js";

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-index-"));
  store = new TaskStore(root);
  await store.ensureDirs();
  takeTaskFileReads();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("TaskStore status index", () => {
  it("counts by directory and names the running tasks, without reading the files", async () => {
    await store.create(newTask(fm()));
    await store.create(newTask(fm({ id: "t2", status: "done" })));
    await store.create(newTask(fm({ id: "run", status: "running" })));
    await mkdir(workingAreaDir(root, "ghost"), { recursive: true });

    const summary = await store.statusSummary();
    expect(takeTaskFileReads()).toBe(0);
    expect(summary.counts).toEqual({ pending: 1, done: 1, running: 1 });
    expect(summary.running).toEqual(["run"]);

    // A second call is the cached directory listing.
    expect(await store.statusSummary()).toEqual(summary);
    expect(takeTaskFileReads()).toBe(0);
  });

  it("follows a transition and a task written by another process", async () => {
    await store.create(newTask(fm()));
    expect((await store.statusSummary()).counts).toEqual({ pending: 1 });
    await store.transition("t1", "running");
    expect(await store.statusSummary()).toEqual({ counts: { running: 1 }, running: ["t1"] });

    await writeFile(
      taskFilePath(root, "pending", "t2"),
      serializeTask(newTask(fm({ id: "t2", title: "from outside" }))),
    );
    const summary = await store.statusSummary();
    expect(summary.counts).toEqual({ pending: 1, running: 1 });
    expect(summary.running).toEqual(["t1"]);
    expect(takeTaskFileReads()).toBe(0);
  });

  it("counts a task that sits in two status directories once, under the newer updated", async () => {
    const older = newTask(fm({ status: "pending", updated: "2026-06-04T10:00:00.000Z" }));
    const newer = newTask(fm({ status: "running", updated: "2026-06-04T11:00:00.000Z" }));
    await writeFile(taskFilePath(root, "pending", "t1"), serializeTask(older));
    await mkdir(workingAreaDir(root, "t1"), { recursive: true });
    await writeFile(taskFilePath(root, "running", "t1"), serializeTask(newer));

    expect(await store.statusSummary()).toEqual({ counts: { running: 1 }, running: ["t1"] });
    // Only the two copies are read, to see which updated is later.
    expect(takeTaskFileReads()).toBe(2);

    const pendingNewer = newTask(fm({ id: "t2", updated: "2026-06-04T12:00:00.000Z" }));
    const runningOlder = newTask(
      fm({ id: "t2", status: "running", updated: "2026-06-04T09:00:00.000Z" }),
    );
    await writeFile(taskFilePath(root, "pending", "t2"), serializeTask(pendingNewer));
    await mkdir(workingAreaDir(root, "t2"), { recursive: true });
    await writeFile(taskFilePath(root, "running", "t2"), serializeTask(runningOlder));
    const summary = await store.statusSummary();
    expect(summary.counts).toEqual({ pending: 1, running: 1 });
    expect(summary.running).toEqual(["t1"]);
  });
});

describe("TaskStore list cache", () => {
  it("serves an unchanged file from memory and sees a later write", async () => {
    await store.create(newTask(fm(), "prompt"));
    const first = await store.list();
    expect(takeTaskFileReads()).toBe(1);
    expect(first[0]?.frontmatter.title).toBe("T1");

    first[0]!.frontmatter.labels.push("local");
    first[0]!.body.log = "mutated";
    const second = await store.list();
    expect(takeTaskFileReads()).toBe(0);
    expect(second[0]?.frontmatter.labels).toEqual([]);
    expect(second[0]?.body.log).toBe("");

    const saved = await store.get("t1");
    saved!.frontmatter.title = "saved title";
    await store.save(saved!);
    expect((await store.list())[0]?.frontmatter.title).toBe("saved title");

    const outside = (await store.get("t1"))!;
    // Same serialized length as "T1": invalidation is the file mtime, not the size.
    outside.frontmatter.title = "T2";
    await writeFile(taskFilePath(root, "pending", "t1"), serializeTask(outside));
    expect((await store.list())[0]?.frontmatter.title).toBe("T2");

    outside.frontmatter.title = "outside title with more bytes";
    await writeFile(taskFilePath(root, "pending", "t1"), serializeTask(outside));
    expect((await store.list())[0]?.frontmatter.title).toBe("outside title with more bytes");
  });

  it("reuses a pending listing while that directory is unchanged", async () => {
    await store.create(newTask(fm()));
    await store.create(newTask(fm({ id: "t2", priority: 10 })));
    expect((await store.listByStatus("pending")).map((t) => t.frontmatter.id).sort()).toEqual([
      "t1",
      "t2",
    ]);

    takeTaskFileReads();
    takeTaskStatCalls();
    const again = await store.listByStatus("pending");
    expect(again.map((t) => t.frontmatter.id).sort()).toEqual(["t1", "t2"]);
    expect(takeTaskFileReads()).toBe(0);
    expect(takeTaskStatCalls()).toBe(0);
    again[0]!.frontmatter.priority = 1;

    const saved = (await store.get("t2"))!;
    saved.frontmatter.title = "renamed";
    await store.save(saved);
    expect(
      (await store.listByStatus("pending")).find((t) => t.frontmatter.id === "t2")?.frontmatter
        .title,
    ).toBe("renamed");
    expect(
      (await store.listByStatus("pending")).find((t) => t.frontmatter.id === "t1")?.frontmatter
        .priority,
    ).not.toBe(1);

    await writeFile(taskFilePath(root, "pending", "t3"), serializeTask(newTask(fm({ id: "t3" }))));
    expect((await store.listByStatus("pending")).map((t) => t.frontmatter.id).sort()).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  it("reads only the new pending file when the directory gains one", async () => {
    for (let i = 0; i < 30; i++) await store.create(newTask(fm({ id: `p${i}` })));
    expect(await store.listByStatus("pending")).toHaveLength(30);

    takeTaskFileReads();
    takeTaskStatCalls();
    await store.create(newTask(fm({ id: "extra" })));
    takeTaskFileReads();
    takeTaskStatCalls();
    const ids = (await store.listByStatus("pending")).map((t) => t.frontmatter.id);
    expect(ids).toHaveLength(31);
    expect(ids).toContain("extra");
    expect(takeTaskFileReads()).toBe(1);
    expect(takeTaskStatCalls()).toBe(1);
  });

  it("reads only the pending file this process saved", async () => {
    for (let i = 0; i < 30; i++) await store.create(newTask(fm({ id: `p${i}` })));
    await store.listByStatus("pending");
    const saved = (await store.get("p3"))!;
    saved.frontmatter.title = "changed";
    await store.save(saved);

    takeTaskFileReads();
    takeTaskStatCalls();
    const again = await store.listByStatus("pending");
    expect(again.find((t) => t.frontmatter.id === "p3")?.frontmatter.title).toBe("changed");
    expect(again.find((t) => t.frontmatter.id === "p0")?.frontmatter.title).toBe("T1");
    expect(takeTaskFileReads()).toBe(1);
    expect(takeTaskStatCalls()).toBe(1);
  });

  it("sees an outside rename over an existing pending file", async () => {
    await store.create(newTask(fm()));
    await store.create(newTask(fm({ id: "t2" })));
    await store.listByStatus("pending");
    const path = taskFilePath(root, "pending", "t1");
    const outside = (await store.get("t1"))!;
    outside.frontmatter.title = "replaced from outside";
    const tmp = `${path}.replacing`;
    await writeFile(tmp, serializeTask(outside));
    await rename(tmp, path);
    expect(
      (await store.listByStatus("pending")).find((t) => t.frontmatter.id === "t1")?.frontmatter
        .title,
    ).toBe("replaced from outside");
  });

  it("agrees with the status index", async () => {
    await store.create(newTask(fm()));
    await store.transition("t1", "running");
    await store.transition("t1", "done");
    await store.create(newTask(fm({ id: "t2", status: "pending" })));
    const listed = await store.list();
    const counts: Record<string, number> = {};
    for (const task of listed) {
      counts[task.frontmatter.status] = (counts[task.frontmatter.status] ?? 0) + 1;
    }
    expect((await store.statusSummary()).counts).toEqual(counts);
  });
});

describe("task scans at soak scale", () => {
  const N = 2012;

  async function writeSoak(): Promise<void> {
    const log = `${"agent output line\n".repeat(80)}done.`;
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      const status: Status =
        i === 0 ? "running" : i < 400 ? "pending" : i < 406 ? "failed" : "done";
      const id = `s${String(i).padStart(4, "0")}`;
      const task = newTask(
        fm({
          id,
          title: `soak ${i}`,
          status,
          updated: `2026-11-10T13:${String(i % 60).padStart(2, "0")}:${String(i % 50).padStart(2, "0")}.000Z`,
        }),
        "Do the thing. verdict: APPROVE",
      );
      task.body.log = log;
      task.body.reports.reviewer = "APPROVE";
      jobs.push(
        (async () => {
          const path = taskFilePath(root, status, id);
          if (status === "running") await mkdir(statusDir(root, "running"), { recursive: true });
          if (status === "running") await mkdir(workingAreaDir(root, id), { recursive: true });
          await writeFile(path, serializeTask(task));
        })(),
      );
      if (jobs.length >= 64) {
        await Promise.all(jobs);
        jobs.length = 0;
      }
    }
    await Promise.all(jobs);
  }

  it("status is a directory listing, and paging the list does not re-read every file", async () => {
    await writeSoak();
    takeTaskFileReads();

    // GET /api/v1/runner/status counts from the status directories.
    const statusStarted = performance.now();
    const summary = await store.statusSummary();
    const statusMs = performance.now() - statusStarted;
    expect(takeTaskFileReads()).toBe(0);
    expect(summary.counts).toEqual({ running: 1, pending: 399, failed: 6, done: N - 406 });
    expect(summary.running).toEqual(["s0000"]);
    expect(statusMs).toBeLessThan(5_000);

    // Listing every task, one page of 100 at a time, used to parse every file per page.
    const listStarted = performance.now();
    for (let page = 0; page < 21; page++) {
      const tasks = await store.list();
      expect(tasks).toHaveLength(N);
    }
    const listMs = performance.now() - listStarted;
    expect(takeTaskFileReads()).toBe(N);
    expect(listMs).toBeLessThan(15_000);

    const again = performance.now();
    expect((await store.statusSummary()).counts.done).toBe(N - 406);
    expect(performance.now() - again).toBeLessThan(5_000);
    expect(takeTaskFileReads()).toBe(0);
  }, 60_000);
});
