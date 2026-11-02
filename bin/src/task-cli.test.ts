import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTaskInHierarchy,
  EpicStore,
  newTask,
  ProjectStore,
  TaskStore,
} from "@boof-runner/shared";
import { execCommand } from "@boof-runner/runner";
import { projectCommand } from "./project-cli.js";
import { taskCommand } from "./task-cli.js";

let base: string;
let root: string;
let out: string[];
let errs: string[];
let dir: string;

const run = (...argv: string[]) =>
  taskCommand(
    argv,
    () => root,
    (l) => out.push(l),
    (l) => errs.push(l),
  );
const mk = (id: string, extra: object = {}) =>
  createTaskInHierarchy(
    dir,
    newTask(
      {
        id,
        title: id.toUpperCase(),
        status: "pending",
        priority: 50,
        skip: false,
        labels: [],
        command: null,
        attachments: [],
        questions: "none",
        runs: 1,
        completedRuns: 0,
        created: "",
        updated: "",
        ...extra,
      },
      "p",
    ),
  );

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-runner-taskcli-")));
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
  dir = new ProjectStore(root).dir("demo");
  await new EpicStore(dir).create({ title: "Web" });
  out = [];
  errs = [];
});
afterEach(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe("boof-runner task", () => {
  it("lists children indented under their parent in priority order", async () => {
    await mk("p", { priority: 10, epicId: "web" });
    await mk("top", { priority: 90 });
    await mk("lo", { parentId: "p", priority: 10 });
    await mk("hi", { parentId: "p", priority: 70 });
    expect(await run("list", "-d", root)).toBe(0);
    const lines = out.map((l) => l.trim());
    expect(lines[0]).toMatch(/^top\b/);
    expect(lines[1]).toMatch(/^p\b.*epic:web.*0\/2/);
    expect(lines[2]).toMatch(/^↳ hi\b/);
    expect(lines[3]).toMatch(/^↳ lo\b/);
  });

  it("filters with --epic none and --parent none, and prints a child whose parent is filtered out", async () => {
    await mk("p", { epicId: "web" });
    await mk("c", { parentId: "p" });
    await mk("free");
    await run("list", "--epic", "none", "-d", root);
    expect(out.join("\n")).toMatch(/^free\b/m);
    expect(out.join("\n")).not.toMatch(/^p\b/m);
    out.length = 0;
    await run("list", "--parent", "p", "-d", root);
    expect(out.join("\n")).toMatch(/c\b.*↳ p$/m);
    out.length = 0;
    await run("list", "--parent", "none", "--json", "-d", root);
    expect(
      JSON.parse(out.join("\n"))
        .map((t: { id: string }) => t.id)
        .sort(),
    ).toEqual(["free", "p"]);
  });

  it("moves a task under a parent and back with --parent none", async () => {
    await mk("p");
    await mk("t", { epicId: "web" });
    expect(await run("move", "t", "--parent", "p", "-d", root)).toBe(0);
    const t = (await new TaskStore(dir).get("t"))!.frontmatter;
    expect(t.parentId).toBe("p");
    expect(t.epicId).toBeUndefined();
    expect(await run("move", "t", "--parent", "none", "-d", root)).toBe(0);
    expect((await new TaskStore(dir).get("t"))!.frontmatter.parentId).toBeUndefined();
    expect(await run("move", "t", "--epic", "web", "-d", root)).toBe(0);
    expect((await new TaskStore(dir).get("t"))!.frontmatter.epicId).toBe("web");
  });

  it("refuses a grandchild and a move without flags with exit 1", async () => {
    await mk("p");
    await mk("c", { parentId: "p" });
    await mk("g");
    expect(await run("move", "g", "--parent", "c", "-d", root)).toBe(1);
    expect(errs.join("\n")).toContain("task move:");
    errs.length = 0;
    expect(await run("move", "g", "-d", root)).toBe(1);
    expect(errs.join("\n")).toContain("--epic or --parent");
  });
});
