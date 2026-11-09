import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./atomic.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidIdError, projectPaths } from "./paths.js";
import { isAnthropicApiKey, ProjectPatchSchema, ProjectSchema } from "./schema.js";
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
    const s = new ProjectStore(root, { isGitRepo: deepGit, repoCommonDir: fakeTop });
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

  it("update with expectedUpdated applies once; the loser of a race gets modified", async () => {
    const created = await store.create({ workingDirectory: await makeRepo("a"), id: "a" });
    const results = await Promise.allSettled([
      store.update("a", { brief: "one" }, { expectedUpdated: created.updated }),
      store.update("a", { brief: "two" }, { expectedUpdated: created.updated }),
    ]);
    const lost = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: "modified" });
    expect(["one", "two"]).toContain((await store.get("a"))!.brief);
    await expect(
      store.update("a", { brief: "late" }, { expectedUpdated: created.updated }),
    ).rejects.toBeInstanceOf(ProjectError);
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

it("ProjectSchema parses a project.json without brief, and ProjectPatchSchema takes brief or null", () => {
  const minimal = {
    id: "a",
    name: "A",
    workingDirectory: "/x",
    origin: { kind: "cli" },
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
  };
  expect(ProjectSchema.parse(minimal).brief).toBeUndefined();
  expect(ProjectSchema.parse(minimal).claudeAgent).toBeUndefined();
  expect(ProjectSchema.parse({ ...minimal, claudeAgent: {} }).claudeAgent).toEqual({
    auth: "gateway",
  });
  expect(ProjectSchema.safeParse({ ...minimal, claudeAgent: { auth: "oauth" } }).success).toBe(
    false,
  );
  expect(ProjectPatchSchema.parse({ claudeAgent: null })).toEqual({ claudeAgent: null });
  expect(ProjectPatchSchema.parse({ brief: "  Build it  " })).toEqual({ brief: "Build it" });
  expect(ProjectPatchSchema.parse({ brief: null })).toEqual({ brief: null });
});

it("accepts only Anthropic API keys for project-key auth", () => {
  expect(isAnthropicApiKey("sk-ant-api03-" + "a".repeat(40))).toBe(true);
  expect(isAnthropicApiKey("sk-ant-oat01-" + "a".repeat(40))).toBe(false);
  expect(isAnthropicApiKey("sk-ant-admin01-" + "a".repeat(40))).toBe(false);
  expect(isAnthropicApiKey("btr-" + "a".repeat(40))).toBe(false);
  expect(isAnthropicApiKey("sk-ant-api03-" + "a".repeat(19) + " " + "a".repeat(20))).toBe(false);
  expect(isAnthropicApiKey("sk-ant-api03-" + "a".repeat(600))).toBe(false);
});

describe("create with path modes", () => {
  let inits: string[];
  let pstore: ProjectStore;
  const fakeInit = async (d: string) => {
    await mkdir(join(d, ".git"), { recursive: true });
    await writeFile(join(d, ".git", "HEAD"), "ref: refs/heads/main\n");
    inits.push(d);
  };
  beforeEach(() => {
    inits = [];
    pstore = new ProjectStore(root, { isGitRepo: fakeGit, initGitRepo: fakeInit });
  });
  const repo = (name: string) => makeRepo(name);

  it("new: creates the directory, runs initGitRepo, derives the id from the folder and stores the brief", async () => {
    const dir = join(base, "repos", "My New App");
    const p = await pstore.create({
      workingDirectory: dir,
      path: { mode: "new" },
      brief: "  A shop  ",
    });
    expect(p).toMatchObject({ id: "my-new-app", workingDirectory: dir, brief: "A shop" });
    expect(inits).toEqual([dir]);
    const onDisk = JSON.parse(await readFile(projectPaths(root, "my-new-app").json, "utf8"));
    expect(onDisk.brief).toBe("A shop");
  });

  it("new: an empty existing directory and one holding only .git need no confirm", async () => {
    const empty = join(base, "repos", "empty");
    await mkdir(empty, { recursive: true });
    await expect(
      pstore.create({ workingDirectory: empty, path: { mode: "new" } }),
    ).resolves.toBeTruthy();
    const gitOnly = join(base, "repos", "gitonly");
    await mkdir(join(gitOnly, ".git"), { recursive: true });
    await writeFile(join(gitOnly, ".git", "HEAD"), "ref: refs/heads/main\n");
    await expect(
      pstore.create({ workingDirectory: gitOnly, path: { mode: "new" } }),
    ).resolves.toBeTruthy();
  });

  it("new: refuses a non-empty directory without confirm and initialises it with confirm", async () => {
    const dir = join(base, "repos", "full");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.txt"), "");
    await expect(
      pstore.create({ workingDirectory: dir, path: { mode: "new" } }),
    ).rejects.toMatchObject({ code: "directory_not_empty" });
    expect(inits).toEqual([]);
    const p = await pstore.create({ workingDirectory: dir, path: { mode: "new", confirm: true } });
    expect(p.workingDirectory).toBe(dir);
    expect(inits).toEqual([dir]);
  });

  it("new: refuses a path that is a file", async () => {
    const f = join(base, "afile");
    await writeFile(f, "x");
    await expect(
      pstore.create({ workingDirectory: f, path: { mode: "new", confirm: true } }),
    ).rejects.toMatchObject({ code: "not_a_directory" });
    expect(existsSync(f)).toBe(true);
  });

  it("new: never initialises / , the home directory or a directory containing home or the data root, even with confirm", async () => {
    const fakeHome = join(base, "fakehome");
    await mkdir(join(fakeHome, "sub"), { recursive: true });
    vi.stubEnv("HOME", fakeHome);
    try {
      for (const dir of ["/", fakeHome, base]) {
        await expect(
          pstore.create({ workingDirectory: dir, path: { mode: "new", confirm: true } }),
        ).rejects.toMatchObject({ code: "directory_not_allowed" });
      }
      expect(inits).toEqual([]);
      expect(existsSync(join(fakeHome, ".git"))).toBe(false);
      // a project directory below home is fine
      const ok = join(fakeHome, "sub", "proj");
      expect(
        (await pstore.create({ workingDirectory: ok, path: { mode: "new" } })).workingDirectory,
      ).toBe(ok);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("new: a relative path is a ProjectError, for new and for a relative auto projectsRoot", async () => {
    await expect(
      pstore.create({ workingDirectory: "rel/dir", path: { mode: "new" } }),
    ).rejects.toMatchObject({ name: "ProjectError", code: "directory_not_allowed" });
    await expect(
      pstore.create({ path: { mode: "auto", projectsRoot: "relroot" }, name: "x" }),
    ).rejects.toMatchObject({ name: "ProjectError", code: "directory_not_allowed" });
  });

  it("new: a target below a regular file is not_a_directory", async () => {
    const f = join(base, "afile");
    await writeFile(f, "x");
    await expect(
      pstore.create({ workingDirectory: join(f, "p"), path: { mode: "new" } }),
    ).rejects.toMatchObject({ code: "not_a_directory" });
  });

  it("new: refuses ..evil inside the data root", async () => {
    await expect(
      pstore.create({ workingDirectory: join(root, "..evil"), path: { mode: "new" } }),
    ).rejects.toMatchObject({ code: "inside_data_root" });
    expect(existsSync(join(root, "..evil"))).toBe(false);
  });

  it("new: a directory that appears before the exclusive mkdir is never deleted", async () => {
    const dir = join(base, "repos", "raced");
    const s = new ProjectStore(root, {
      isGitRepo: fakeGit,
      beforeCreateDir: async (d) => {
        await mkdir(d, { recursive: true });
        await writeFile(join(d, "precious.txt"), "keep");
      },
    });
    await expect(s.create({ workingDirectory: dir, path: { mode: "new" } })).rejects.toMatchObject({
      code: "directory_create_failed",
    });
    expect(existsSync(join(dir, "precious.txt"))).toBe(true);
  });

  describe("assertTarget (the caller's check on the path the store really uses)", () => {
    const allowed = () => join(base, "allowed");
    const guard = async (real: string) => {
      const { realpath } = await import("node:fs/promises");
      const root = await realpath(allowed());
      if (!real.startsWith(root + "/")) throw new Error(`refused ${real}`);
    };
    beforeEach(async () => {
      await mkdir(allowed(), { recursive: true });
      await mkdir(join(base, "outside"), { recursive: true });
      await writeFile(join(base, "outside", "precious.txt"), "keep");
    });

    it("new: a symlink planted after the caller's check is caught after the mkdir, and nothing outside is touched", async () => {
      const s = new ProjectStore(root, {
        isGitRepo: fakeGit,
        initGitRepo: fakeInit,
        // The parent is made first; swap it for a link just before the final mkdir.
        beforeCreateDir: async () => {
          await rm(join(allowed(), "parent"), { recursive: true });
          await symlink(join(base, "outside"), join(allowed(), "parent"));
        },
      });
      await expect(
        s.create({
          workingDirectory: join(allowed(), "parent", "child"),
          path: { mode: "new" },
          assertTarget: guard,
        }),
      ).rejects.toThrow(/refused/);
      expect(existsSync(join(base, "outside", "child"))).toBe(false);
      expect(await s.list()).toEqual([]);
    });

    it("new + confirm: a leaf symlink planted before resolution is refused with nothing initialised", async () => {
      const dir = join(allowed(), "leaf");
      // Stands for a link planted between the caller's check and the store.
      const s = new ProjectStore(root, { isGitRepo: fakeGit, initGitRepo: fakeInit });
      await symlink(join(base, "outside"), dir);
      await expect(
        s.create({
          workingDirectory: dir,
          path: { mode: "new", confirm: true },
          assertTarget: guard,
        }),
      ).rejects.toThrow(/refused/);
      expect(existsSync(join(base, "outside", ".git"))).toBe(false);
      expect(existsSync(join(base, "outside", "precious.txt"))).toBe(true);
    });

    it("auto: the target under the projects root is checked (explicit id that is a symlink)", async () => {
      const projectsRoot = join(allowed(), "pr");
      await mkdir(projectsRoot);
      await symlink(join(base, "outside"), join(projectsRoot, "trap"));
      const s = new ProjectStore(root, { isGitRepo: fakeGit, initGitRepo: fakeInit });
      await expect(
        s.create({
          path: { mode: "auto", projectsRoot },
          id: "trap",
          brief: "b",
          assertTarget: guard,
        }),
      ).rejects.toThrow(/refused/);
      expect(existsSync(join(base, "outside", ".git"))).toBe(false);
    });

    it("new: a refusal on the check after the mkdir rolls back what it made", async () => {
      const parent = join(allowed(), "swap");
      let calls = 0;
      const s = new ProjectStore(root, { isGitRepo: fakeGit, initGitRepo: fakeInit });
      await expect(
        s.create({
          workingDirectory: join(parent, "child"),
          path: { mode: "new" },
          assertTarget: async (real) => {
            calls++;
            if (calls === 2) throw new Error("refused on the second look");
            await guard(real);
          },
        }),
      ).rejects.toThrow(/second look/);
      expect(calls).toBe(2);
      expect(existsSync(join(parent, "child"))).toBe(false);
      expect(existsSync(parent)).toBe(false);
    });

    it("new: the rollback after a refused second look never deletes recursively", async () => {
      const child = join(allowed(), "swap", "child");
      let calls = 0;
      const s = new ProjectStore(root, { isGitRepo: fakeGit, initGitRepo: fakeInit });
      await expect(
        s.create({
          workingDirectory: child,
          path: { mode: "new" },
          assertTarget: async (real) => {
            calls++;
            // Stands for something that landed in the directory (or a re-pointed parent) meanwhile.
            if (calls === 2) {
              await writeFile(join(real, "precious.txt"), "keep");
              throw new Error("refused on the second look");
            }
            await guard(real);
          },
        }),
      ).rejects.toThrow(/second look/);
      expect(await readFile(join(child, "precious.txt"), "utf8")).toBe("keep");
    });

    it("update: a changed working directory goes through assertTarget with the vetted real path", async () => {
      const a = await makeRepo("a");
      const b = await makeRepo("b");
      const link = join(base, "blink");
      await symlink(b, link);
      const p = await store.create({ workingDirectory: a });
      const seen: string[] = [];
      await expect(
        store.update(
          p.id,
          { workingDirectory: link },
          {
            assertTarget: async (real) => {
              seen.push(real);
              throw new Error("refused");
            },
          },
        ),
      ).rejects.toThrow(/refused/);
      expect(seen).toEqual([b]);
      expect((await store.get(p.id))?.workingDirectory).toBe(a);
      // Unchanged directories and other fields do not call it.
      await store.update(
        p.id,
        { name: "n", workingDirectory: a },
        {
          assertTarget: async () => {
            throw new Error("must not run");
          },
        },
      );
    });

    it("existing: the real path of a work tree is checked too", async () => {
      const outside = join(base, "outside");
      await fakeInit(outside);
      await symlink(outside, join(allowed(), "link"));
      const s = new ProjectStore(root, { isGitRepo: fakeGit });
      await expect(
        s.create({ workingDirectory: join(allowed(), "link"), assertTarget: guard }),
      ).rejects.toThrow(/refused/);
      expect(await s.list()).toEqual([]);
    });
  });

  it("new: two concurrent creates on one path: one wins and its directory survives", async () => {
    const slow = async (d: string) => {
      await new Promise((r) => setTimeout(r, 30));
      await fakeInit(d);
    };
    const s = new ProjectStore(root, { isGitRepo: fakeGit, initGitRepo: slow });
    const dir = join(base, "repos", "dup");
    const results = await Promise.allSettled([
      s.create({ workingDirectory: dir, path: { mode: "new" } }),
      s.create({ workingDirectory: dir, path: { mode: "new" } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(existsSync(join(dir, ".git", "HEAD"))).toBe(true);
    expect((await s.list()).map((p) => p.workingDirectory)).toEqual([dir]);
  });

  it("auto: concurrent creates with one name get different ids and directories", async () => {
    const projectsRoot = join(base, "auto-root");
    const [a, b] = await Promise.all([
      pstore.create({ path: { mode: "auto", projectsRoot }, name: "Shop" }),
      pstore.create({ path: { mode: "auto", projectsRoot }, name: "Shop" }),
    ]);
    expect(a.id).not.toBe(b.id);
    expect(a.workingDirectory).not.toBe(b.workingDirectory);
    expect(existsSync(a.workingDirectory)).toBe(true);
    expect(existsSync(b.workingDirectory)).toBe(true);
  });

  it("auto and new agree: a directory holding only .git is empty for both", async () => {
    const projectsRoot = join(base, "auto-root");
    await mkdir(join(projectsRoot, "shop", ".git"), { recursive: true });
    const p = await pstore.create({ path: { mode: "auto", projectsRoot }, name: "shop" });
    expect(p.id).toBe("shop");
  });

  it("new: registration failing after the directory was made removes it (and the parents it made), keeps an existing one", async () => {
    const noGit = new ProjectStore(root, { isGitRepo: fakeGit }); // no init: vetting says not_git_repo
    const deep = join(base, "p1", "p2", "target");
    await expect(
      noGit.create({ workingDirectory: deep, path: { mode: "new" } }),
    ).rejects.toMatchObject({ code: "not_git_repo" });
    expect(existsSync(deep)).toBe(false);
    expect(existsSync(join(base, "p1"))).toBe(false);
    // a parent that already existed stays
    const parent = join(base, "keepparent");
    await mkdir(parent);
    await expect(
      noGit.create({ workingDirectory: join(parent, "t"), path: { mode: "new" } }),
    ).rejects.toMatchObject({ code: "not_git_repo" });
    expect(existsSync(join(parent, "t"))).toBe(false);
    expect(existsSync(parent)).toBe(true);
    // a pre-existing empty directory survives the same failure
    const kept = join(base, "keptempty");
    await mkdir(kept);
    await expect(
      noGit.create({ workingDirectory: kept, path: { mode: "new" } }),
    ).rejects.toMatchObject({ code: "not_git_repo" });
    expect(existsSync(kept)).toBe(true);
  });

  it("new: a duplicate found after the directory was made removes the new directory only", async () => {
    const first = await pstore.create({
      workingDirectory: join(base, "r", "one"),
      path: { mode: "new" },
    });
    // same directory again via a symlink spelling: exists, so not created, must survive
    const link = join(base, "lnk");
    await symlink(first.workingDirectory, link);
    await expect(
      pstore.create({ workingDirectory: link, path: { mode: "new" } }),
    ).rejects.toMatchObject({ code: "duplicate" });
    expect(existsSync(join(first.workingDirectory, ".git"))).toBe(true);
  });

  it("new: a failing ensureDirs leaves no project.json and removes the created directory", async () => {
    const spy = vi.spyOn(ProjectStore.prototype, "ensureDirs").mockRejectedValue(new Error("disk"));
    try {
      const dir = join(base, "repos", "ens");
      await expect(pstore.create({ workingDirectory: dir, path: { mode: "new" } })).rejects.toThrow(
        "disk",
      );
      expect(existsSync(dir)).toBe(false);
      expect(await pstore.list({ includeArchived: true })).toEqual([]);
      expect(existsSync(projectPaths(root, "ens").json)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("new: refuses a target inside the data root before creating anything", async () => {
    await expect(
      pstore.create({ workingDirectory: join(root, "x"), path: { mode: "new" } }),
    ).rejects.toMatchObject({ code: "inside_data_root" });
    expect(existsSync(join(root, "x"))).toBe(false);
  });

  it("new: removes the directory it created when registration fails, and keeps one it did not create", async () => {
    await pstore.create({ workingDirectory: await repo("taken"), id: "taken" });
    const fresh = join(base, "repos", "fresh");
    await expect(
      pstore.create({ workingDirectory: fresh, path: { mode: "new" }, id: "taken" }),
    ).rejects.toMatchObject({ code: "id_taken" });
    expect(existsSync(fresh)).toBe(false);
    const kept = join(base, "repos", "kept");
    await mkdir(kept, { recursive: true });
    await expect(
      pstore.create({ workingDirectory: kept, path: { mode: "new" }, id: "taken" }),
    ).rejects.toMatchObject({ code: "id_taken" });
    expect(existsSync(kept)).toBe(true);
  });

  it("new: a directory it could not create leaves nothing behind", async () => {
    if (process.getuid?.() === 0) return; // root ignores modes
    const ro = join(base, "ro");
    await mkdir(ro);
    await chmod(ro, 0o500);
    try {
      await expect(
        pstore.create({ workingDirectory: join(ro, "p"), path: { mode: "new" } }),
      ).rejects.toMatchObject({ code: "directory_create_failed" });
      expect(existsSync(join(ro, "p"))).toBe(false);
    } finally {
      await chmod(ro, 0o700);
    }
  });

  it("new: a failing initGitRepo rolls the created directory back", async () => {
    const s = new ProjectStore(root, {
      isGitRepo: fakeGit,
      initGitRepo: async () => {
        throw new Error("git exploded");
      },
    });
    const dir = join(base, "repos", "boom");
    await expect(s.create({ workingDirectory: dir, path: { mode: "new" } })).rejects.toMatchObject({
      code: "directory_create_failed",
    });
    expect(existsSync(dir)).toBe(false);
  });

  it("new: a failing initGitRepo leaves a directory it did not create alone", async () => {
    const s = new ProjectStore(root, {
      isGitRepo: fakeGit,
      initGitRepo: async () => {
        throw new Error("git exploded");
      },
    });
    const dir = join(base, "repos", "mine");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "keep.txt"), "x");
    await expect(
      s.create({ workingDirectory: dir, path: { mode: "new", confirm: true } }),
    ).rejects.toMatchObject({ code: "directory_create_failed" });
    expect(existsSync(join(dir, "keep.txt"))).toBe(true);
  });

  it("new: a dangling symlink as the target (or an ancestor) fails cleanly and nothing is followed or deleted", async () => {
    const outside = join(base, "outside");
    const link = join(base, "dangling");
    await symlink(outside, link);
    await expect(
      pstore.create({ workingDirectory: link, path: { mode: "new", confirm: true } }),
    ).rejects.toMatchObject({ code: "directory_create_failed" });
    expect(existsSync(outside)).toBe(false);
    await expect(
      pstore.create({ workingDirectory: join(link, "sub"), path: { mode: "new" } }),
    ).rejects.toMatchObject({ code: "directory_create_failed" });
    expect(existsSync(outside)).toBe(false);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(inits).toEqual([]);
  });

  it("new: an entry access() cannot see (no search permission on the parent) fails cleanly", async () => {
    if (process.getuid?.() === 0) return;
    const closed = join(base, "closed");
    await mkdir(join(closed, "p"), { recursive: true });
    await writeFile(join(closed, "p", "keep.txt"), "x");
    await chmod(closed, 0o000);
    try {
      await expect(
        pstore.create({
          workingDirectory: join(closed, "p"),
          path: { mode: "new", confirm: true },
        }),
      ).rejects.toMatchObject({ code: "directory_create_failed" });
    } finally {
      await chmod(closed, 0o700);
    }
    expect(existsSync(join(closed, "p", "keep.txt"))).toBe(true);
    expect(inits).toEqual([]);
  });

  it("auto: creates <projectsRoot>/<id> with the id from the name, skipping taken ids and occupied directories", async () => {
    const projectsRoot = join(base, "auto-root");
    const a = await pstore.create({
      path: { mode: "auto", projectsRoot },
      name: "Shop Front",
      brief: "b",
    });
    expect(a).toMatchObject({
      id: "shop-front",
      name: "Shop Front",
      workingDirectory: join(projectsRoot, "shop-front"),
    });
    await mkdir(join(projectsRoot, "shop-front-2"));
    await writeFile(join(projectsRoot, "shop-front-2", "x"), "");
    const b = await pstore.create({ path: { mode: "auto", projectsRoot }, name: "Shop Front" });
    expect(b.id).toBe("shop-front-3");
    const c = await pstore.create({ path: { mode: "auto", projectsRoot } });
    expect(c.id).toBe("project");
  });

  it("auto: honours an explicit id and refuses a taken one without touching the disk", async () => {
    const projectsRoot = join(base, "auto-root");
    const a = await pstore.create({ path: { mode: "auto", projectsRoot }, id: "x" });
    expect(a.workingDirectory).toBe(join(projectsRoot, "x"));
    await expect(
      pstore.create({ path: { mode: "auto", projectsRoot }, id: "x" }),
    ).rejects.toMatchObject({ code: "id_taken" });
    expect(existsSync(join(projectsRoot, "x", ".git"))).toBe(true);
    expect(inits).toEqual([join(projectsRoot, "x")]);
  });

  it("existing: a create without path behaves as before (git work tree required, no init)", async () => {
    await expect(pstore.create({ workingDirectory: join(base, "nope") })).rejects.toMatchObject({
      code: "directory_missing",
    });
    expect(inits).toEqual([]);
  });

  it("existing/new without workingDirectory is directory_missing", async () => {
    await expect(pstore.create({})).rejects.toMatchObject({ code: "directory_missing" });
    await expect(pstore.create({ path: { mode: "new" } })).rejects.toMatchObject({
      code: "directory_missing",
    });
  });

  it("new: a project.json another writer publishes first is id_taken and is never removed", async () => {
    const s = new ProjectStore(root, {
      isGitRepo: fakeGit,
      initGitRepo: fakeInit,
      beforeCreateDir: async () => {
        await atomicWrite(projectPaths(root, "x").json, "winner");
      },
    });
    const dir = join(base, "repos", "one");
    await expect(
      s.create({ workingDirectory: dir, path: { mode: "new" }, id: "x" }),
    ).rejects.toMatchObject({ code: "id_taken" });
    expect(await readFile(projectPaths(root, "x").json, "utf8")).toBe("winner");
    expect(existsSync(dir)).toBe(false); // this call made it, so it is rolled back
  });

  it("new: the rollback never deletes a directory another project was registered on meanwhile", async () => {
    const dir = join(base, "repos", "shared");
    const s = new ProjectStore(root, {
      isGitRepo: fakeGit,
      initGitRepo: async (d) => {
        await fakeInit(d);
        const now = new Date().toISOString();
        const other = ProjectSchema.parse({
          id: "other",
          name: "other",
          workingDirectory: d,
          origin: { kind: "api" },
          created: now,
          updated: now,
        });
        await atomicWrite(projectPaths(root, "other").json, JSON.stringify(other));
      },
    });
    await expect(
      s.create({ workingDirectory: dir, path: { mode: "new" }, id: "mine" }),
    ).rejects.toMatchObject({ code: "duplicate" });
    expect(existsSync(join(dir, ".git", "HEAD"))).toBe(true);
  });

  it("new: a failing ensureDirs removes project.json even when the data directory already existed", async () => {
    await mkdir(projectPaths(root, "zz").dir, { recursive: true });
    await writeFile(join(projectPaths(root, "zz").dir, "keep.txt"), "x");
    const spy = vi.spyOn(ProjectStore.prototype, "ensureDirs").mockRejectedValue(new Error("disk"));
    try {
      await expect(
        pstore.create({
          workingDirectory: join(base, "repos", "zz"),
          path: { mode: "new" },
          id: "zz",
        }),
      ).rejects.toThrow("disk");
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(projectPaths(root, "zz").json)).toBe(false);
    expect(existsSync(join(projectPaths(root, "zz").dir, "keep.txt"))).toBe(true);
  });

  describe("across processes", () => {
    const child = fileURLToPath(new URL("../test-support/create-child.mts", import.meta.url));
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const run = (startAt: number, input: object) =>
      new Promise<{ ok: boolean; id?: string; code?: string }>((resolve, reject) => {
        execFile(
          process.execPath,
          ["--import", "tsx", child, root, String(startAt), JSON.stringify(input)],
          { cwd: repoRoot },
          (err, stdout, stderr) => {
            if (err) return reject(new Error(`${err.message}\n${stderr}`));
            resolve(JSON.parse(stdout.trim().split("\n").pop() as string));
          },
        );
      });

    it("two processes creating one id at different paths: exactly one wins and its project.json is intact", async () => {
      const startAt = Date.now() + 1500;
      const one = join(base, "repos", "one");
      const two = join(base, "repos", "two");
      const res = await Promise.all([
        run(startAt, { workingDirectory: one, path: { mode: "new" }, id: "x" }),
        run(startAt, { workingDirectory: two, path: { mode: "new" }, id: "x" }),
      ]);
      expect(res.map((r) => r.ok).sort()).toEqual([false, true]);
      expect(res.find((r) => !r.ok)?.code).toBe("id_taken");
      const projects = await pstore.list({ includeArchived: true });
      expect(projects).toHaveLength(1);
      expect(existsSync(join(projects[0].workingDirectory, ".git", "HEAD"))).toBe(true);
    }, 30000);

    it("two processes creating ids a and b on one empty directory: one wins, the directory stays", async () => {
      const dir = join(base, "repos", "empty");
      await mkdir(dir, { recursive: true });
      const startAt = Date.now() + 1500;
      const res = await Promise.all([
        run(startAt, { workingDirectory: dir, path: { mode: "new" }, id: "a" }),
        run(startAt, { workingDirectory: dir, path: { mode: "new" }, id: "b" }),
      ]);
      expect(res.map((r) => r.ok).sort()).toEqual([false, true]);
      expect((await pstore.list({ includeArchived: true })).map((p) => p.workingDirectory)).toEqual(
        [dir],
      );
      expect(existsSync(dir)).toBe(true);
    }, 30000);

    it("a slow creator in one process and a later one in another never delete a registered directory", async () => {
      const dir = join(base, "repos", "d");
      const t = Date.now() + 1500;
      const res = await Promise.all([
        run(t, { workingDirectory: dir, path: { mode: "new" }, id: "slow" }),
        run(t + 100, { workingDirectory: dir, path: { mode: "new" }, id: "fast" }),
      ]);
      expect(res.filter((r) => r.ok)).toHaveLength(1);
      const [p] = await pstore.list({ includeArchived: true });
      expect(existsSync(p.workingDirectory)).toBe(true);
    }, 30000);

    it("takes over a create lock left by a dead process", async () => {
      await atomicWrite(join(root, "projects", ".create.lock"), "99999999\n");
      const p = await pstore.create({
        workingDirectory: join(base, "repos", "after"),
        path: { mode: "new" },
      });
      expect(p.id).toBe("after");
      expect(existsSync(join(root, "projects", ".create.lock"))).toBe(false);
    });

    it("waits for a live holder and then gives up with a busy error", async () => {
      await atomicWrite(join(root, "projects", ".create.lock"), `${process.ppid}\n`);
      const s = new ProjectStore(root, {
        isGitRepo: fakeGit,
        initGitRepo: fakeInit,
        lock: { lockTimeoutMs: 200, lockPollMs: 20 },
      });
      await expect(
        s.create({ workingDirectory: join(base, "repos", "w"), path: { mode: "new" } }),
      ).rejects.toMatchObject({ code: "busy" });
      expect(existsSync(join(base, "repos", "w"))).toBe(false);
    });
  });

  it("update with brief null clears the stored brief", async () => {
    const p = await pstore.create({ workingDirectory: await repo("b1"), brief: "keep me" });
    expect((await pstore.require(p.id)).brief).toBe("keep me");
    await pstore.update(p.id, { brief: null });
    expect((await pstore.require(p.id)).brief).toBeUndefined();
    const onDisk = JSON.parse(await readFile(projectPaths(root, p.id).json, "utf8"));
    expect("brief" in onDisk).toBe(false);
  });
});
