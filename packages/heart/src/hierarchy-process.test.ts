import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWrite } from "./atomic.js";
import { EpicStore } from "./epic-store.js";
import { createTaskInHierarchy } from "./hierarchy.js";
import { currentBootId } from "./process-lock.js";
import { TaskStore } from "./store.js";
import { newTask } from "./task-file.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boof-runner-hier-proc-"));
  await new TaskStore(dir).ensureDirs();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const child = fileURLToPath(new URL("../test-support/hierarchy-child.mts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const run = (mode: string, startAt: number, arg: string, count: number) =>
  new Promise<{ ok: boolean; ops: number; message?: string }>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", child, dir, mode, String(startAt), arg, String(count)],
      { cwd: repoRoot },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}\n${stderr}`));
        resolve(JSON.parse(stdout.trim().split("\n").pop() as string));
      },
    );
  });

describe("the epics.json lock across processes", () => {
  it("two processes creating epics at once lose none", async () => {
    const startAt = Date.now() + 1500;
    const [a, b] = await Promise.all([
      run("epics", startAt, "a", 25),
      run("epics", startAt, "b", 25),
    ]);
    expect(a).toMatchObject({ ok: true, ops: 25 });
    expect(b).toMatchObject({ ok: true, ops: 25 });
    const titles = (await new EpicStore(dir).list()).map((e) => e.title);
    expect(titles).toHaveLength(50);
  }, 60_000);

  it("fails with a clear error naming the lock when a live process holds it", async () => {
    const lock = join(dir, ".locks", "epics.lock");
    await atomicWrite(lock, `${process.ppid} ${currentBootId()}\n`);
    const store = new EpicStore(dir, { lock: { lockTimeoutMs: 200, lockPollMs: 20 } });
    await expect(store.create({ title: "x" })).rejects.toThrow(
      /another boof process.*epics\.lock/i,
    );
    expect(await new EpicStore(dir).list()).toEqual([]);
  });
});

describe("the hierarchy lock across processes", () => {
  it("removing an epic with detach never leaves a task naming it, whatever a second process creates", async () => {
    const epics = new EpicStore(dir);
    const rounds = 6;
    for (let r = 0; r < rounds; r++) {
      const id = (await epics.create({ title: `E${r}` })).id;
      const startAt = Date.now() + 1200;
      const [creator, remover] = await Promise.all([
        run("tasks", startAt, id, 30),
        run("remove", startAt, id, 120 + r * 40),
      ]);
      expect(creator.ok, creator.message).toBe(true);
      expect(remover.ok, remover.message).toBe(true);
    }
    const left = new Set((await epics.list()).map((e) => e.id));
    const dangling = (await new TaskStore(dir).list())
      .filter((t) => t.frontmatter.epicId !== undefined && !left.has(t.frontmatter.epicId))
      .map((t) => t.frontmatter.id);
    expect(dangling).toEqual([]);
  }, 90_000);

  it("keeps its lock files out of the project's visible files and removes them after use", async () => {
    const epics = new EpicStore(dir);
    const epic = await epics.create({ title: "E" });
    await createTaskInHierarchy(
      dir,
      newTask(
        {
          id: "t",
          title: "t",
          status: "pending",
          priority: 0,
          skip: false,
          labels: [],
          command: null,
          attachments: [],
          questions: "none",
          runs: 1,
          completedRuns: 0,
          epicId: epic.id,
          created: "2026-06-04T10:00:00.000Z",
          updated: "2026-06-04T10:00:00.000Z",
        },
        "t",
      ),
    );
    expect(await readdir(join(dir, ".locks")).catch(() => [])).toEqual([]);
    await expect(stat(join(dir, "epics.json.lock"))).rejects.toThrow();
  });
});
