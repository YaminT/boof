import { mkdtemp, rm, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "./store.js";
import { newTask } from "./task-file.js";
import { statusDir, taskFilePath } from "./paths.js";
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
  root = await mkdtemp(join(tmpdir(), "boof-claw-store-"));
  store = new TaskStore(root);
  await store.ensureDirs();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
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
});

void readFile;
