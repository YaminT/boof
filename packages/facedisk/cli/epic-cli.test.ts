import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskInHierarchy, newTask, ProjectStore, TaskStore, execCommand } from "@boof/heart";
import { epicCommand } from "./epic-cli.js";
import { projectCommand } from "./project-cli.js";

let base: string;
let root: string;
let out: string[];
let errs: string[];

const run = (...argv: string[]) =>
  epicCommand(
    argv,
    () => root,
    (l) => out.push(l),
    (l) => errs.push(l),
  );

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-runner-epiccli-")));
  root = join(base, "data");
  const repo = join(base, "repo");
  await mkdir(repo, { recursive: true });
  await execCommand("git", ["init", "-q"], { cwd: repo });
  await projectCommand(
    ["add", repo, "--id", "demo", "--default", "-d", root],
    () => root,
    () => {},
    () => {},
  );
  out = [];
  errs = [];
});
afterEach(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe("boof-runner epic", () => {
  it("adds, lists and archives epics", async () => {
    expect(await run("add", "Web hooks", "--priority", "5", "-d", root)).toBe(0);
    expect(await run("list", "-d", root)).toBe(0);
    expect(out.join("\n")).toMatch(/web-hooks\s+p5\s+0\/0\s+Web hooks/);
    out.length = 0;
    expect(await run("archive", "web-hooks", "-d", root)).toBe(0);
    out.length = 0;
    await run("list", "-d", root);
    expect(out.join("\n")).not.toContain("web-hooks");
    out.length = 0;
    await run("list", "--all", "-d", root);
    expect(out.join("\n")).toMatch(/web-hooks.*\(archived\)/);
    expect(await run("archive", "web-hooks", "--undo", "-d", root)).toBe(0);
    out.length = 0;
    await run("list", "--json", "-d", root);
    expect(JSON.parse(out.join("\n"))[0]).toMatchObject({
      id: "web-hooks",
      progress: { total: 0, done: 0 },
    });
  });

  it("remove refuses with tasks and detaches with --detach", async () => {
    await run("add", "Web", "-d", root);
    const dir = new ProjectStore(root).dir("demo");
    await createTaskInHierarchy(
      dir,
      newTask(
        {
          id: "x",
          title: "T",
          status: "pending",
          priority: 1,
          skip: false,
          labels: [],
          command: null,
          attachments: [],
          questions: "none",
          runs: 1,
          completedRuns: 0,
          epicId: "web",
          created: "",
          updated: "",
        },
        "p",
      ),
    );
    expect(await run("remove", "web", "-d", root)).toBe(1);
    expect(errs.join("\n")).toContain("has 1 task");
    expect(await run("remove", "web", "--detach", "-d", root)).toBe(0);
    expect((await new TaskStore(dir).get("t"))!.frontmatter.epicId).toBeUndefined();
  });

  it("reports a missing epic and bad input with exit 1", async () => {
    expect(await run("archive", "nope", "-d", root)).toBe(1);
    expect(errs.join("\n")).toContain("epic archive:");
    expect(await run("add", "x", "--priority", "abc", "-d", root)).toBe(1);
    expect(await run("add", "", "-d", root)).toBe(1);
  });

  it("prints usage and exits 1 without a subcommand", async () => {
    expect(await run()).toBe(1);
    expect(out.join("\n")).toContain("boof-runner epic add");
  });
});
