import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore, SettingsStore } from "@boof-runner/shared";
import { execCommand } from "@boof-runner/runner";
import { projectCommand } from "./project-cli.js";
import { main } from "./boof-runner.js";

let base: string;
let root: string;
let out: string[];
let errs: string[];

const run = (...argv: string[]) =>
  projectCommand(
    argv,
    () => root,
    (l) => out.push(l),
    (l) => errs.push(l),
  );

async function repo(name: string, git = true): Promise<string> {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  if (git) await execCommand("git", ["init", "-q"], { cwd: dir });
  return realpath(dir);
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-runner-projcli-")));
  root = join(base, "data");
  out = [];
  errs = [];
});
afterEach(async () => {
  process.exitCode = undefined;
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("boof-runner project", () => {
  it("add refuses a subdirectory of a registered repository", async () => {
    const dir = await repo("My App");
    await mkdir(join(dir, "sub"), { recursive: true });
    expect(await run("add", dir, "-d", root)).toBe(0);
    expect(await run("add", join(dir, "sub"), "-d", root)).toBe(1);
    expect(errs.join("\n")).toContain("repository of project 'my-app'");
  });

  it("add registers a git repository and prints its id; list shows it; --json is parseable", async () => {
    const dir = await repo("My App");
    expect(await run("add", dir, "-d", root)).toBe(0);
    expect(out.join("\n")).toContain(`Added project 'my-app' (${dir})`);
    out = [];
    expect(await run("list", "-d", root)).toBe(0);
    expect(out.join("\n")).toMatch(/my-app\s+active\s+My App\s+/);
    out = [];
    expect(await run("list", "--json", "-d", root)).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: "my-app",
      workingDirectory: dir,
      origin: { kind: "cli" },
    });
  });

  it("add takes --id, --name and --default; the default is marked in list", async () => {
    const a = await repo("a");
    const b = await repo("b");
    expect(
      await run("add", a, "--id", "alpha", "--name", "Alpha Project", "--default", "-d", root),
    ).toBe(0);
    expect(await run("add", b, "-d", root)).toBe(0);
    expect((await new SettingsStore(root).load()).defaultProject).toBe("alpha");
    out = [];
    await run("list", "-d", root);
    const lines = out.join("\n").split("\n");
    expect(lines.find((l) => l.includes("alpha"))).toMatch(/^\* alpha/);
    expect(lines.find((l) => l.includes(" b "))).toMatch(/^ {2}b/);
    expect(out.join("\n")).toContain("Alpha Project");
  });

  it("add resolves a relative directory and a symlink, and rejects a duplicate", async () => {
    const dir = await repo("app");
    const link = join(base, "alias");
    await symlink(dir, link);
    const cwd = process.cwd();
    process.chdir(base);
    try {
      expect(await run("add", "app", "-d", root)).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    errs = [];
    expect(await run("add", link, "-d", root)).toBe(1);
    expect(errs.join("\n")).toMatch(/already project 'app'/);
  });

  it("add rejects a non-git directory, a missing one, a bad id and a missing argument", async () => {
    const plain = await repo("plain", false);
    expect(await run("add", plain, "-d", root)).toBe(1);
    expect(errs.join("\n")).toMatch(/Not a git repository/);
    errs = [];
    expect(await run("add", join(base, "nope"), "-d", root)).toBe(1);
    expect(errs.join("\n")).toMatch(/does not exist/);
    errs = [];
    expect(await run("add", await repo("ok"), "--id", "Bad Id", "-d", root)).toBe(1);
    expect(errs.join("\n")).toMatch(/Invalid id/);
    errs = [];
    expect(await run("add", "-d", root)).toBe(1);
    expect(errs.join("\n")).toMatch(/directory is required/);
    expect(await new ProjectStore(root).list()).toEqual([]);
  });

  it("remove archives by default, --purge deletes the data (and the default), never the repo", async () => {
    const dir = await repo("app");
    await run("add", dir, "--default", "-d", root);
    expect(await run("remove", "app", "-d", root)).toBe(0);
    expect(out.join("\n")).toContain("Archived project 'app'");
    expect((await new ProjectStore(root).get("app"))?.archived).toBe(true);
    out = [];
    await run("list", "-d", root);
    expect(out.join("\n")).toContain("archived");

    expect(await run("remove", "app", "--purge", "-d", root)).toBe(0);
    expect(await new ProjectStore(root).get("app")).toBeNull();
    expect((await new SettingsStore(root).load()).defaultProject).toBeNull();
    expect(await readFile(join(dir, ".git", "HEAD"), "utf8")).toContain("ref:");

    errs = [];
    expect(await run("remove", "app", "-d", root)).toBe(1);
    expect(errs.join("\n")).toMatch(/not found/);
    expect(await run("remove", "-d", root)).toBe(1);
  });

  it("remove refuses while a task is running", async () => {
    await run("add", await repo("app"), "-d", root);
    await mkdir(join(root, "projects", "app", "tasks", "ongoing", "t1"), { recursive: true });
    await writeFile(join(root, "projects", "app", "tasks", "ongoing", "t1", "task.md"), "x");
    expect(await run("remove", "app", "--purge", "-d", root)).toBe(1);
    expect(errs.join("\n")).toMatch(/running task/);
    expect(await new ProjectStore(root).get("app")).not.toBeNull();
  });

  it("list on an empty root hints how to add one; help and unknown subcommands behave", async () => {
    expect(await run("list", "-d", root)).toBe(0);
    expect(out.join("\n")).toContain("project add <dir>");
    out = [];
    expect(await run("--help")).toBe(0);
    expect(out.join("\n")).toContain("project add <dir>");
    expect(await run()).toBe(1);
    expect(await run("frobnicate", "-d", root)).toBe(1);
    expect(await run("add", "x", "--nope", "-d", root)).toBe(1);
  });

  it("is reachable as `boof-runner project …` and honours BOOF_RUNNER_DATA_ROOT", async () => {
    const dir = await repo("app");
    const log = console.log;
    const lines: string[] = [];
    console.log = (l: string) => void lines.push(l);
    const prev = process.env.BOOF_RUNNER_DATA_ROOT;
    process.env.BOOF_RUNNER_DATA_ROOT = root;
    try {
      await main(["project", "add", dir]);
    } finally {
      console.log = log;
      if (prev === undefined) delete process.env.BOOF_RUNNER_DATA_ROOT;
      else process.env.BOOF_RUNNER_DATA_ROOT = prev;
    }
    expect(lines.join("\n")).toContain("Added project 'app'");
    expect((await new ProjectStore(root).list()).map((p) => p.id)).toEqual(["app"]);
  });
});
