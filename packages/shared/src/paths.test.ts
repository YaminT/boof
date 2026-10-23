import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InvalidIdError,
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
