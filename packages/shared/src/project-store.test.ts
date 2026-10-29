import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidIdError, projectPaths } from "./paths.js";
import { ProjectError, ProjectStore } from "./project-store.js";
import { TaskStore } from "./store.js";

let root: string;
let base: string;
let store: ProjectStore;

/** Stand-in validator: a directory is a "git repo" when it contains a `.git` entry. */
const fakeGit = async (dir: string) => {
  try {
    await readFile(join(dir, ".git", "HEAD"));
    return true;
  } catch {
    return false;
  }
};

async function makeRepo(name: string): Promise<string> {
  const dir = join(base, name);
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  return dir;
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-runner-projects-")));
  root = join(base, "data");
  await mkdir(root, { recursive: true });
  store = new ProjectStore(root, { isGitRepo: fakeGit });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("ProjectStore", () => {
  it("creates a project: realpath, derived id and name, status directories, project.json", async () => {
    const dir = await makeRepo("My App");
    const link = join(base, "link");
    await symlink(dir, link);
    const p = await store.create({ workingDirectory: link });
    expect(p.id).toBe("my-app");
    expect(p.name).toBe("My App");
    expect(p.workingDirectory).toBe(dir); // realpath, not the symlink
    expect(p.paused).toBe(false);
    expect(p.archived).toBe(false);
    expect(p.planWriteBack).toBe(true);
    expect(p.origin).toEqual({ kind: "api" });
    const onDisk = JSON.parse(await readFile(projectPaths(root, "my-app").json, "utf8"));
    expect(onDisk.workingDirectory).toBe(dir);
    // ensureDirs: the project dir works as a TaskStore root
    expect(await new TaskStore(store.dir("my-app")).list()).toEqual([]);
  });

  it("derives unique ids for equally named directories and honours an explicit id", async () => {
    const a = await makeRepo("a/app");
    const b = await makeRepo("b/app");
    expect((await store.create({ workingDirectory: a })).id).toBe("app");
    expect((await store.create({ workingDirectory: b })).id).toBe("app-2");
    const c = await makeRepo("c");
    expect((await store.create({ workingDirectory: c, id: "custom", name: "Custom" })).name).toBe(
      "Custom",
    );
    const d = await makeRepo("d");
    await expect(store.create({ workingDirectory: d, id: "custom" })).rejects.toMatchObject({
      code: "id_taken",
    });
    await expect(store.create({ workingDirectory: d, id: "Bad Id" })).rejects.toThrow(
      InvalidIdError,
    );
  });

  it("falls back to 'project' for a directory name with no kebab characters", async () => {
    const dir = await makeRepo("日本語");
    expect((await store.create({ workingDirectory: dir })).id).toBe("project");
  });

  it("rejects a non-git directory, a missing directory and a path inside the data root", async () => {
    const plain = join(base, "plain");
    await mkdir(plain);
    await expect(store.create({ workingDirectory: plain })).rejects.toMatchObject({
      code: "not_git_repo",
    });
    await expect(store.create({ workingDirectory: join(base, "nope") })).rejects.toMatchObject({
      code: "directory_missing",
    });
    const inside = join(root, "repo");
    await mkdir(join(inside, ".git"), { recursive: true });
    await writeFile(join(inside, ".git", "HEAD"), "x");
    await expect(store.create({ workingDirectory: inside })).rejects.toMatchObject({
      code: "inside_data_root",
    });
    await expect(store.create({ workingDirectory: inside })).rejects.toBeInstanceOf(ProjectError);
  });

  /** Stand-in toplevel: the nearest ancestor (or self) holding `.git/HEAD`. */
  const fakeTop = async (dir: string): Promise<string | null> => {
    for (let d = dir; ; d = join(d, "..")) {
      if (await fakeGit(d)) return realpath(d);
      if (join(d, "..") === d || d === "/") return null;
    }
  };
  const deepGit = async (dir: string) => (await fakeTop(dir)) !== null;

  it("rejects a directory inside another project's repository, on create and update", async () => {
    const s = new ProjectStore(root, { isGitRepo: deepGit, repoToplevel: fakeTop });
    const mono = await makeRepo("mono");
    await mkdir(join(mono, "packages", "web"), { recursive: true });
    await s.create({ workingDirectory: mono, id: "mono" });
    await expect(
      s.create({ workingDirectory: join(mono, "packages", "web") }),
    ).rejects.toMatchObject({
      code: "same_repo",
      message: expect.stringContaining("repository of project 'mono'"),
    });
    const other = await s.create({ workingDirectory: await makeRepo("other") });
    await expect(
      s.update(other.id, { workingDirectory: join(mono, "packages") }),
    ).rejects.toMatchObject({
      code: "same_repo",
    });
    await expect(s.update("mono", { name: "Mono" })).resolves.toMatchObject({ name: "Mono" });
    expect((await s.list()).map((p) => p.id)).toEqual(["mono", "other"]);
  });

  it("rejects a duplicate working directory, also through a symlink", async () => {
    const dir = await makeRepo("app");
    await store.create({ workingDirectory: dir });
    const link = join(base, "alias");
    await symlink(dir, link);
    await expect(store.create({ workingDirectory: dir })).rejects.toMatchObject({
      code: "duplicate",
    });
    await expect(store.create({ workingDirectory: link })).rejects.toMatchObject({
      code: "duplicate",
    });
  });

  it("skips the git check when no validator is injected", async () => {
    const plain = join(base, "plain");
    await mkdir(plain);
    const unchecked = new ProjectStore(root);
    expect((await unchecked.create({ workingDirectory: plain })).id).toBe("plain");
  });

  it("lists sorted by id, hides archived unless asked, and gets by id", async () => {
    const b = await store.create({ workingDirectory: await makeRepo("b") });
    await store.create({ workingDirectory: await makeRepo("a") });
    expect((await store.list()).map((p) => p.id)).toEqual(["a", "b"]);
    await store.archive(b.id);
    expect((await store.list()).map((p) => p.id)).toEqual(["a"]);
    expect((await store.list({ includeArchived: true })).map((p) => p.id)).toEqual(["a", "b"]);
    expect((await store.get("b"))?.archived).toBe(true);
    expect(await store.get("zzz")).toBeNull();
    await expect(store.get("../x")).rejects.toThrow(InvalidIdError);
  });

  it("finds a project by the realpath of a directory", async () => {
    const dir = await makeRepo("app");
    const link = join(base, "alias");
    await symlink(dir, link);
    const p = await store.create({ workingDirectory: dir });
    expect((await store.findByDirectory(link))?.id).toBe(p.id);
    expect(await store.findByDirectory(join(base, "nope"))).toBeNull();
  });

  it("update serializes concurrent patches so neither is lost", async () => {
    await store.create({ workingDirectory: await makeRepo("a"), id: "a" });
    await Promise.all([
      store.update("a", { name: "Renamed" }),
      store.update("a", { labels: ["x"] }),
    ]);
    const p = (await store.get("a"))!;
    expect(p.name).toBe("Renamed");
    expect(p.labels).toEqual(["x"]);
  });

  it("updates fields, clears optional ones with null and bumps `updated`", async () => {
    const p = await store.create({ workingDirectory: await makeRepo("app") });
    const u = await store.update("app", {
      name: "Renamed",
      paused: true,
      defaultBase: "develop",
      review: { gate: false },
      labels: ["x"],
    });
    expect(u).toMatchObject({
      name: "Renamed",
      paused: true,
      defaultBase: "develop",
      review: { gate: false },
      labels: ["x"],
    });
    expect(u.updated >= p.updated).toBe(true);
    const cleared = await store.update("app", { defaultBase: null, review: null, paused: false });
    expect(cleared.defaultBase).toBeUndefined();
    expect(cleared.review).toBeUndefined();
    expect(cleared.paused).toBe(false);
    await expect(store.update("nope", { name: "x" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("re-validates a changed working directory on update", async () => {
    await store.create({ workingDirectory: await makeRepo("app") });
    const other = await makeRepo("other");
    await store.create({ workingDirectory: other });
    await expect(store.update("app", { workingDirectory: other })).rejects.toMatchObject({
      code: "duplicate",
    });
    const plain = join(base, "plain");
    await mkdir(plain);
    await expect(store.update("app", { workingDirectory: plain })).rejects.toMatchObject({
      code: "not_git_repo",
    });
    const moved = await makeRepo("moved");
    expect((await store.update("app", { workingDirectory: moved })).workingDirectory).toBe(moved);
  });

  it("archives on remove and purges the data directory only with purge", async () => {
    const repo = await makeRepo("app");
    await store.create({ workingDirectory: repo });
    await store.remove("app");
    expect((await store.get("app"))?.archived).toBe(true);
    await store.remove("app", { purge: true });
    expect(await store.get("app")).toBeNull();
    expect(await readFile(join(repo, ".git", "HEAD"), "utf8")).toContain("main"); // repo untouched
    await expect(store.remove("app")).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses to remove a project while a task is running", async () => {
    await store.create({ workingDirectory: await makeRepo("app") });
    await mkdir(join(store.dir("app"), "tasks", "ongoing", "t1"), { recursive: true });
    await expect(store.remove("app", { purge: true })).rejects.toMatchObject({
      code: "has_running_task",
    });
    expect(await store.get("app")).not.toBeNull();
  });

  it("skips unreadable project directories when listing", async () => {
    await store.create({ workingDirectory: await makeRepo("app") });
    await mkdir(join(root, "projects", "broken"), { recursive: true });
    await writeFile(join(root, "projects", "broken", "project.json"), "{not json");
    expect((await store.list()).map((p) => p.id)).toEqual(["app"]);
  });
});
