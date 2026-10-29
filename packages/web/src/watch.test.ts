import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "@boof-runner/shared";
import { DataWatcher, type ChangeData } from "./watch.js";

let base: string;
let root: string;
let watcher: DataWatcher;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "boof-runner-watch-"));
  root = join(base, "data");
  const projects = new ProjectStore(root);
  await mkdir(join(root, "commands"), { recursive: true });
  for (const id of ["alpha", "beta"]) {
    const dir = join(base, "repos", id);
    await mkdir(dir, { recursive: true });
    await projects.create({ workingDirectory: dir, id });
  }
  await writeFile(join(root, "settings.json"), "{}");
  watcher = new DataWatcher(root, 50);
});

afterEach(async () => {
  await watcher.stop();
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

describe("DataWatcher", () => {
  it("broadcasts a debounced ping carrying the project id when a task file changes", async () => {
    const events: [string, ChangeData][] = [];
    watcher.subscribe((e, d) => events.push([e, d]));
    watcher.start();
    // Give chokidar a moment to attach watchers.
    await settle(300);

    await writeFile(join(root, "projects", "alpha", "tasks", "pending", "x.md"), "hello", "utf8");
    await settle();
    expect(events).toEqual([["changed", { project: "alpha" }]]);
  });

  it("reports changes in two projects separately and global changes without a project", async () => {
    const events: ChangeData[] = [];
    watcher.subscribe((_, d) => events.push(d));
    watcher.start();
    await settle(300);

    await writeFile(join(root, "projects", "alpha", "tasks", "pending", "a.md"), "a");
    await writeFile(join(root, "projects", "beta", "tasks", "drafts", "b.md"), "b");
    await writeFile(join(root, "commands", "c.md"), "c");
    await settle();
    expect(events).toHaveLength(3);
    expect(events).toContainEqual({ project: "alpha" });
    expect(events).toContainEqual({ project: "beta" });
    expect(events).toContainEqual({});
  });

  it("sees deep changes: a running task's report is within the watch depth", async () => {
    const events: ChangeData[] = [];
    const dir = join(root, "projects", "beta", "tasks", "ongoing", "t1", "reports");
    await mkdir(dir, { recursive: true });
    watcher.subscribe((_, d) => events.push(d));
    watcher.start();
    await settle(300);
    await writeFile(join(dir, "developer.md"), "x");
    await settle();
    expect(events).toEqual([{ project: "beta" }]);
  });

  it("broadcast() defaults to an empty payload", () => {
    const seen: ChangeData[] = [];
    watcher.subscribe((_, d) => seen.push(d));
    watcher.broadcast("changed");
    expect(seen).toEqual([{}]);
  });
});
