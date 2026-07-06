import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "@boof-claw/shared";
import { DataWatcher } from "./watch.js";

let root: string;
let watcher: DataWatcher;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-claw-watch-"));
  await new TaskStore(root).ensureDirs();
  watcher = new DataWatcher(root, 50);
});

afterEach(async () => {
  await watcher.stop();
  await rm(root, { recursive: true, force: true });
});

describe("DataWatcher", () => {
  it("broadcasts a debounced ping when a task file changes", async () => {
    const events: string[] = [];
    watcher.subscribe((e) => events.push(e));
    watcher.start();
    // Give chokidar a moment to attach watchers.
    await new Promise((r) => setTimeout(r, 300));

    await writeFile(join(root, "tasks", "pending", "x.md"), "hello", "utf8");

    await new Promise((r) => setTimeout(r, 600));
    expect(events).toContain("changed");
  });
});
