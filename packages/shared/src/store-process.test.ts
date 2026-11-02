import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWrite } from "./atomic.js";
import { ALL_STATUSES, statusDir, taskFilePath } from "./paths.js";
import type { TaskFrontmatter } from "./schema.js";
import { TaskStore } from "./store.js";
import { newTask } from "./task-file.js";

let root: string;
let store: TaskStore;

const fm = (over: Partial<TaskFrontmatter> = {}): TaskFrontmatter => ({
  id: "t1",
  title: "T1",
  status: "pending",
  priority: 0,
  skip: false,
  labels: [],
  command: null,
  attachments: [],
  questions: "none",
  created: "2026-06-04T10:00:00.000Z",
  updated: "2026-06-04T10:00:00.000Z",
  ...over,
});

const fileExists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-store-proc-"));
  store = new TaskStore(root);
  await store.ensureDirs();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the task lock across processes", () => {
  const lockFile = () => join(root, "tasks", ".locks", "t1.lock");

  it("a CLI-side modify and the server's transitions never lose a write or resurrect a file", async () => {
    await store.create(newTask(fm()));
    const child = fileURLToPath(new URL("../test-support/task-child.mts", import.meta.url));
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const run = (mode: string, startAt: number, ops: number) =>
      new Promise<{ ok: boolean; ops: number; message?: string }>((resolve, reject) => {
        execFile(
          process.execPath,
          ["--import", "tsx", child, root, mode, String(startAt), "t1", String(ops)],
          { cwd: repoRoot },
          (err, stdout, stderr) => {
            if (err) return reject(new Error(`${err.message}\n${stderr}`));
            resolve(JSON.parse(stdout.trim().split("\n").pop() as string));
          },
        );
      });
    const startAt = Date.now() + 1500;
    const [server, editor] = await Promise.all([
      run("server", startAt, 40),
      run("editor", startAt, 60),
    ]);
    expect(server).toMatchObject({ ok: true, ops: 40 });
    expect(editor).toMatchObject({ ok: true, ops: 60 });

    const t = (await store.get("t1"))!;
    expect(t.frontmatter.status).toBe("pending");
    expect(t.frontmatter.completedRuns).toBe(40); // no transition write was overwritten
    expect(t.frontmatter.priority).toBe(60); // no modify was lost
    // Exactly one file, in the status the task ended in: a modify that wrote to the path the
    // task had just left would have recreated it there.
    const copies: string[] = [];
    for (const status of ALL_STATUSES) {
      for (const name of await readdir(statusDir(root, status)).catch(() => [] as string[])) {
        if (name.startsWith("t1")) copies.push(`${status}/${name}`);
      }
    }
    expect(copies).toEqual(["pending/t1.md"]);
  }, 60_000);

  it("keeps its lock files out of the status directories and removes them after use", async () => {
    await store.create(newTask(fm()));
    await store.modify("t1", (t) => void (t.frontmatter.priority += 1));
    await store.transition("t1", "running");
    expect(await fileExists(lockFile())).toBe(false);
    expect((await store.list()).map((t) => t.frontmatter.id)).toEqual(["t1"]);
    for (const status of ALL_STATUSES) {
      const names = await readdir(statusDir(root, status)).catch(() => [] as string[]);
      expect(names.filter((n) => n.includes("lock"))).toEqual([]);
    }
  });

  it("waits for another live process, then fails with a clear error and writes nothing", async () => {
    await store.create(newTask(fm()));
    await atomicWrite(lockFile(), `${process.ppid}\n`);
    const s = new TaskStore(root, { lock: { lockTimeoutMs: 200, lockPollMs: 20 } });
    await expect(s.modify("t1", (t) => void (t.frontmatter.priority += 1))).rejects.toThrow(
      /another boof process/i,
    );
    expect((await store.get("t1"))!.frontmatter.priority).toBe(0);
  });

  it("takes over a lock left by a dead process", async () => {
    await store.create(newTask(fm()));
    await atomicWrite(lockFile(), "99999999\n");
    await store.modify("t1", (t) => void (t.frontmatter.priority += 1));
    expect((await store.get("t1"))!.frontmatter.priority).toBe(1);
    expect(await fileExists(lockFile())).toBe(false);
  });

  it("still runs writes to different tasks in parallel", async () => {
    await store.create(newTask(fm({ id: "a" })));
    await store.create(newTask(fm({ id: "b" })));
    await Promise.all([
      store.modify("a", (t) => void (t.frontmatter.priority += 1)),
      store.modify("b", (t) => void (t.frontmatter.priority += 1)),
    ]);
    expect((await store.get("a"))!.frontmatter.priority).toBe(1);
    expect(taskFilePath(root, "pending", "b")).toBeTruthy();
  });
});
