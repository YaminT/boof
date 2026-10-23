import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dataPaths,
  dataRootPaths,
  InvalidIdError,
  projectPaths,
  taskAssetsDir,
  taskControlDir,
  taskFilePath,
  taskStopRequestPath,
  workingAreaDir,
} from "./paths.js";
import { TaskStore } from "./store.js";

const BAD = ["..", "a/b", "A", "", "../x"];

describe("path builders reject non-kebab ids", () => {
  const builders: [string, (root: string, id: string) => unknown][] = [
    ["taskAssetsDir", taskAssetsDir],
    ["taskControlDir", taskControlDir],
    ["taskStopRequestPath", taskStopRequestPath],
    ["workingAreaDir", workingAreaDir],
    ["taskFilePath", (r, id) => taskFilePath(r, "pending", id)],
    ["projectPaths", projectPaths],
  ];
  for (const [name, fn] of builders) {
    it(`${name} throws InvalidIdError`, () => {
      for (const bad of BAD) expect(() => fn("/data", bad), bad).toThrow(InvalidIdError);
    });
  }

  it("accepts a valid id", () => {
    expect(() => taskAssetsDir("/data", "my-task-1")).not.toThrow();
  });
});

describe("data root layout v2 paths", () => {
  it("dataRootPaths and projectPaths", () => {
    expect(dataRootPaths("/d")).toMatchObject({
      root: "/d",
      settings: "/d/settings.json",
      runnerPid: "/d/.runner.pid",
      commands: "/d/commands",
      projects: "/d/projects",
      auth: "/d/auth",
      audit: "/d/audit",
    });
    expect(projectPaths("/d", "app")).toEqual({
      dir: "/d/projects/app",
      json: "/d/projects/app/project.json",
      tasks: "/d/projects/app/tasks",
      plans: "/d/projects/app/plans",
      usage: "/d/projects/app/usage.json",
      events: "/d/projects/app/events.jsonl",
    });
  });

  it("dataPaths stays as a deprecated alias", () => {
    expect(dataPaths("/d")).toMatchObject({ settings: "/d/settings.json", tasks: "/d/tasks" });
  });

  it("a project dir is a valid root for the task path helpers", () => {
    const { dir } = projectPaths("/d", "app");
    expect(taskFilePath(dir, "pending", "t1")).toBe("/d/projects/app/tasks/pending/t1.md");
  });
});

describe("TaskStore id handling", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "boof-runner-paths-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("locate and get throw before touching disk", async () => {
    const store = new TaskStore(join(root, "does-not-exist"));
    await expect(store.locate("../x")).rejects.toThrow(InvalidIdError);
    await expect(store.get("../x")).rejects.toThrow(InvalidIdError);
  });
});
