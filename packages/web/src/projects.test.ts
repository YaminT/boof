import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthStore,
  defaultSettings,
  SecuritySettingsSchema,
  SettingsStore,
  type Scope,
} from "@boof-runner/shared";
import { execCommand, MockTool, ToolRegistry } from "@boof-runner/runner";
import { createApp } from "./app.js";
import { TaskService } from "@boof-runner/api";
import { DataWatcher } from "./watch.js";

let base: string; // holds the data root and the repositories
let root: string;
let service: TaskService;
let authStore: AuthStore;
let peer: string;
let watcher: DataWatcher;
let app: ReturnType<typeof createApp>;

const LOOPBACK = "127.0.0.1";
const REMOTE = "10.1.2.3";

async function repo(name: string, opts: { git?: boolean; parent?: string } = {}): Promise<string> {
  const dir = join(opts.parent ?? base, "repos", name);
  await mkdir(dir, { recursive: true });
  if (opts.git !== false) await execCommand("git", ["init", "-q"], { cwd: dir });
  return realpath(dir);
}

const call = (path: string, init: RequestInit = {}, key?: string) =>
  app.request("http://localhost" + path, {
    ...init,
    headers: { ...(init.headers as object), ...(key ? { authorization: `Bearer ${key}` } : {}) },
  });
const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const post = (body?: unknown) => send("POST", body);
const put = (body?: unknown) => send("PUT", body);

async function mint(scopes: Scope[], projects: string[] | "*" = "*", name = "c") {
  return (await authStore.create({ name, scopes, projects, trust: "trusted" })).key;
}

async function setSecurity(patch: Record<string, unknown>) {
  const settings = new SettingsStore(root);
  const cur = await settings.load();
  await settings.save({
    ...cur,
    security: SecuritySettingsSchema.parse({ ...cur.security, ...patch }),
  });
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-runner-projects-web-")));
  root = join(base, "data");
  await mkdir(root, { recursive: true });
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  await new SettingsStore(root).save(defaultSettings());
  authStore = new AuthStore(root);
  peer = LOOPBACK;
  watcher = new DataWatcher(root, 20);
  app = createApp({ service, watcher, authStore, peerAddress: () => peer });
});
afterEach(async () => {
  await watcher.stop();
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("project routes", () => {
  it("creates, lists, gets and patches a project", async () => {
    const dir = await repo("My App");
    const res = await call("/api/projects", post({ workingDirectory: dir }));
    expect(res.status).toBe(200);
    const created = await res.json();
    expect(created).toMatchObject({
      id: "my-app",
      name: "My App",
      workingDirectory: dir,
      paused: false,
      archived: false,
      origin: { kind: "ui" },
    });

    expect((await (await call("/api/projects")).json()).projects.map((p: any) => p.id)).toEqual([
      "my-app",
    ]);
    expect((await (await call("/api/projects/my-app")).json()).name).toBe("My App");
    const branch = (
      await execCommand("git", ["symbolic-ref", "--short", "HEAD"], { cwd: dir })
    ).stdout.trim();
    expect((await (await call("/api/projects/my-app")).json()).currentBranch).toBe(branch);
    expect((await (await call("/api/projects")).json()).projects[0].currentBranch).toBe(branch);
    await execCommand(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "x"],
      { cwd: dir },
    );
    await execCommand("git", ["checkout", "-q", "--detach"], { cwd: dir });
    expect((await (await call("/api/projects/my-app")).json()).currentBranch).toBeNull();

    const patched = await (
      await call(
        "/api/projects/my-app",
        put({ name: "Renamed", defaultBase: "develop", review: { gate: false } }),
      )
    ).json();
    expect(patched).toMatchObject({
      name: "Renamed",
      defaultBase: "develop",
      review: { gate: false },
    });
    const cleared = await (
      await call("/api/projects/my-app", put({ defaultBase: null, review: null }))
    ).json();
    expect(cleared.defaultBase).toBeUndefined();
    expect(cleared.review).toBeUndefined();

    // A bad patch is a 400 naming the field.
    const bad = await call("/api/projects/my-app", put({ bogus: 1 }));
    expect(bad.status).toBe(400);
    expect((await call("/api/projects/my-app", put({ paused: "yes" }))).status).toBe(400);
  });

  it("rejects a bad create body, a non-git directory, a duplicate and a missing directory", async () => {
    expect((await call("/api/projects", post({}))).status).toBe(400);
    expect((await call("/api/projects", post({ workingDirectory: "/x", extra: 1 }))).status).toBe(
      400,
    );
    const plain = await repo("plain", { git: false });
    const notGit = await call("/api/projects", post({ workingDirectory: plain }));
    expect(notGit.status).toBe(400);
    expect((await notGit.json()).error.code).toBe("not_a_git_repo");
    const missing = await call("/api/projects", post({ workingDirectory: join(base, "nope") }));
    expect(missing.status).toBe(400);

    const dir = await repo("app");
    expect((await call("/api/projects", post({ workingDirectory: dir }))).status).toBe(200);
    const dup = await call("/api/projects", post({ workingDirectory: dir }));
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe("project_exists");
    const idTaken = await call(
      "/api/projects",
      post({ workingDirectory: await repo("other"), id: "app" }),
    );
    expect(idTaken.status).toBe(409);
  });

  it("refuses a project inside the data root", async () => {
    const inside = join(root, "inner");
    await mkdir(inside);
    await execCommand("git", ["init", "-q"], { cwd: inside });
    const res = await call("/api/projects", post({ workingDirectory: inside }));
    expect(res.status).toBe(400);
  });

  it("validates :pid and answers 404 for an unknown project on every project route", async () => {
    for (const path of [
      "/api/projects/nope",
      "/api/projects/nope/tasks",
      "/api/projects/nope/tasks/x",
      "/api/projects/nope/usage",
    ]) {
      const res = await call(path);
      expect(res.status, path).toBe(404);
      expect((await res.json()).error.code).toBe("project_not_found");
    }
    expect((await call("/api/projects/nope/pause", post())).status).toBe(404);
    expect((await call("/api/projects/nope", send("DELETE"))).status).toBe(404);
    for (const bad of ["Bad_Id", "a%2Fb", "UPPER"]) {
      const res = await call(`/api/projects/${bad}/tasks`);
      expect(res.status, bad).toBe(400);
    }
    expect((await call("/api/projects/Bad_Id")).status).toBe(400);
    expect((await call("/api/projects/Bad_Id/usage")).status).toBe(400);
  });

  it("archives, unarchives, pauses and resumes; archived projects are hidden unless asked", async () => {
    await call("/api/projects", post({ workingDirectory: await repo("app") }));
    expect((await (await call("/api/projects/app/pause", post())).json()).paused).toBe(true);
    expect((await (await call("/api/projects/app/resume", post())).json()).paused).toBe(false);
    expect((await (await call("/api/projects/app/archive", post())).json()).archived).toBe(true);
    expect((await (await call("/api/projects")).json()).projects).toEqual([]);
    expect(
      (await (await call("/api/projects?includeArchived=1")).json()).projects.map((p: any) => p.id),
    ).toEqual(["app"]);
    expect((await (await call("/api/projects/app/unarchive", post())).json()).archived).toBe(false);
  });

  it("DELETE archives; ?purge=1 removes the data, clears the default and spares the repository", async () => {
    const dir = await repo("app");
    await call("/api/projects", post({ workingDirectory: dir }));
    await call("/api/settings", put({ defaultProject: "app" }));

    expect((await call("/api/projects/app", send("DELETE"))).status).toBe(200);
    expect((await (await call("/api/projects/app")).json()).archived).toBe(true);

    expect((await call("/api/projects/app?purge=1", send("DELETE"))).status).toBe(200);
    expect((await call("/api/projects/app")).status).toBe(404);
    expect((await service.loadSettings()).defaultProject).toBeNull();
    expect((await call("/api/projects")).status).toBe(200);
  });

  it("refuses DELETE while a task of the project is running", async () => {
    await call("/api/projects", post({ workingDirectory: await repo("app") }));
    await call("/api/projects/app/tasks", post({ title: "Busy", status: "pending" }));
    await service.forProject("app").tasks.transition("busy", "running");
    const res = await call("/api/projects/app?purge=1", send("DELETE"));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("project_busy");
    expect((await call("/api/projects/app")).status).toBe(200);
  });

  it("reports usage per project and the global sum", async () => {
    await call("/api/projects", post({ workingDirectory: await repo("a") }));
    await call("/api/projects", post({ workingDirectory: await repo("b") }));
    const usage = (id: string, n: number) =>
      writeFile(
        join(service.projects.dir(id), "usage.json"),
        JSON.stringify({ inputTokens: n, outputTokens: 1, costUsd: n / 100, known: true }),
      );
    await usage("a", 10);
    await usage("b", 30);
    expect((await (await call("/api/projects/a/usage")).json()).inputTokens).toBe(10);
    expect((await (await call("/api/projects/b/usage")).json()).inputTokens).toBe(30);
    const total = await (await call("/api/usage")).json();
    expect(total).toMatchObject({ inputTokens: 40, outputTokens: 2, known: true });
  });

  it("GET /api/actions aggregates parked tasks across projects", async () => {
    await call("/api/projects", post({ workingDirectory: await repo("a") }));
    await call("/api/projects", post({ workingDirectory: await repo("b") }));
    for (const pid of ["a", "b"]) {
      await call(`/api/projects/${pid}/tasks`, post({ title: "Ask", status: "pending" }));
      const tasks = service.forProject(pid).tasks;
      await tasks.transition("ask", "running");
      await tasks.transition("ask", "action", (t) => {
        t.frontmatter.questions = "pending";
      });
    }
    await call("/api/projects/a/tasks", post({ title: "Quiet", status: "pending" }));
    const { actions } = await (await call("/api/actions")).json();
    expect(actions.map((t: any) => `${t.projectId}/${t.frontmatter.id}`).sort()).toEqual([
      "a/ask",
      "b/ask",
    ]);
  });
});

describe("task routes under /api/projects/:pid", () => {
  beforeEach(async () => {
    await call("/api/projects", post({ workingDirectory: await repo("a") }));
    await call("/api/projects", post({ workingDirectory: await repo("b") }));
  });

  it("keeps each project's tasks apart and adds projectId to responses", async () => {
    const t = await (
      await call("/api/projects/a/tasks", post({ title: "Same", prompt: "A" }))
    ).json();
    expect(t.projectId).toBe("a");
    // The same title in another project gets the same id: ids are per project.
    const u = await (
      await call("/api/projects/b/tasks", post({ title: "Same", prompt: "B" }))
    ).json();
    expect(u.frontmatter.id).toBe("same");
    expect(u.projectId).toBe("b");
    expect((await (await call("/api/projects/a/tasks/same")).json()).body.prompt).toBe("A");
    expect((await (await call("/api/projects/b/tasks/same")).json()).body.prompt).toBe("B");
    const list = await (await call("/api/projects/a/tasks")).json();
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0].projectId).toBe("a");
  });

  it("serves every task route with the same body shapes", async () => {
    const P = "/api/projects/a";
    await call(`${P}/tasks`, post({ title: "One" }));
    await call(`${P}/tasks`, post({ title: "Two" }));
    expect(
      (await (await call(`${P}/tasks/one`, put({ status: "pending", priority: 7 }))).json())
        .frontmatter,
    ).toMatchObject({ status: "pending", priority: 7 });
    expect(
      (await (await call(`${P}/tasks/one/skip`, post({ skip: true }))).json()).frontmatter.skip,
    ).toBe(true);
    const reordered = await (
      await call(`${P}/tasks/reorder`, post({ order: ["two", "one"] }))
    ).json();
    expect(reordered.tasks.map((t: any) => t.frontmatter.id)).toEqual(["two", "one"]);
    expect((await (await call(`${P}/tasks/one/archive`, post())).json()).frontmatter.status).toBe(
      "archived",
    );
    expect((await (await call(`${P}/tasks/one/unarchive`, post())).json()).frontmatter.status).toBe(
      "pending",
    );
    await call(`${P}/tasks`, post({ title: "Three", status: "pending" }));
    await service.forProject("a").tasks.transition("three", "running");
    await service.forProject("a").tasks.transition("three", "failed");
    expect((await (await call(`${P}/tasks/three/retry`, post())).json()).frontmatter.status).toBe(
      "pending",
    );
    expect((await call(`${P}/tasks/two/live-log`)).status).toBe(200);
    expect((await call(`${P}/tasks/two/stop`, post())).status).toBe(400); // not running
    expect((await call(`${P}/tasks/two/inject`, post({ prompt: "x" }))).status).toBe(400);

    // answers loop
    const tasks = service.forProject("a").tasks;
    await tasks.transition("one", "running");
    await tasks.transition("one", "action", (t) => {
      t.frontmatter.questions = "pending";
    });
    const answered = await (await call(`${P}/tasks/one/answers`, post({ answers: "yes" }))).json();
    expect(answered.frontmatter).toMatchObject({ status: "pending", questions: "answered" });

    // attachments
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }),
    );
    const up = await call(`${P}/tasks/two/attachments`, { method: "POST", body: form });
    expect(up.status).toBe(200);
    const file = await call(`${P}/tasks/two/attachments/shot.png`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("deprecation")).toBe("true");
    expect((await call(`${P}/tasks/two/attachments/shot.png`, send("DELETE"))).status).toBe(200);

    expect((await call(`${P}/tasks/two`, send("DELETE"))).status).toBe(200);
    expect((await call(`${P}/tasks/two`)).status).toBe(404);
    // Another project does not see any of it.
    expect((await (await call("/api/projects/b/tasks")).json()).tasks).toEqual([]);
  });

  it("marks every unversioned route deprecated, and /api/v1 not", async () => {
    const old = await call("/api/projects/a/tasks");
    expect(old.headers.get("deprecation")).toBe("true");
    expect(old.headers.get("sunset")).toMatch(/GMT$/);
    expect((await call("/api/v1/projects/a/tasks")).headers.get("deprecation")).toBeNull();
  });
});

describe("legacy /api/tasks alias", () => {
  it("answers 404 no_default_project while settings.defaultProject is unset", async () => {
    for (const [path, init] of [
      ["/api/tasks", undefined],
      ["/api/tasks", post({ title: "x" })],
      ["/api/tasks/x", undefined],
    ] as const) {
      const res = await call(path, init);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("no_default_project");
    }
  });

  it("operates on defaultProject and carries Deprecation: true", async () => {
    await call("/api/projects", post({ workingDirectory: await repo("a") }));
    await call("/api/projects", post({ workingDirectory: await repo("b") }));
    await call("/api/settings", put({ defaultProject: "b" }));

    const created = await call("/api/tasks", post({ title: "Via alias" }));
    expect(created.status).toBe(200);
    expect(created.headers.get("deprecation")).toBe("true");
    expect((await created.json()).projectId).toBe("b");

    const list = await call("/api/tasks");
    expect(list.headers.get("deprecation")).toBe("true");
    expect((await list.json()).tasks.map((t: any) => t.frontmatter.id)).toEqual(["via-alias"]);
    // It landed in project b, not a.
    expect((await (await call("/api/projects/b/tasks")).json()).tasks).toHaveLength(1);
    expect((await (await call("/api/projects/a/tasks")).json()).tasks).toHaveLength(0);

    for (const [path, init] of [
      ["/api/tasks/via-alias", undefined],
      ["/api/tasks/via-alias", put({ title: "Renamed" })],
      ["/api/tasks/via-alias/live-log", undefined],
    ] as const) {
      expect((await call(path, init)).headers.get("deprecation"), path).toBe("true");
    }
    // Errors carry it too (a 404 inside the default project).
    const missing = await call("/api/tasks/nope");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("deprecation")).toBe("true");
  });

  it("serves attachments with the header and follows a changed default", async () => {
    await call("/api/projects", post({ workingDirectory: await repo("a") }));
    await call("/api/settings", put({ defaultProject: "a" }));
    await call("/api/tasks", post({ title: "Pic" }));
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "p.png", { type: "image/png" }));
    await call("/api/tasks/pic/attachments", { method: "POST", body: form });
    const file = await call("/api/tasks/pic/attachments/p.png");
    expect(file.status).toBe(200);
    expect(file.headers.get("deprecation")).toBe("true");
  });

  it("is 404 project_not_found when the default project was removed behind its back", async () => {
    await call("/api/projects", post({ workingDirectory: await repo("a") }));
    await call("/api/settings", put({ defaultProject: "a" }));
    await service.projects.remove("a", { purge: true });
    const res = await call("/api/tasks");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("project_not_found");
  });
});

describe("settings with projects", () => {
  it("no longer accepts workingDirectory and exposes none", async () => {
    const res = await call("/api/settings", put({ workingDirectory: "/x" }));
    expect(res.status).toBe(400);
    const settings = await (await call("/api/settings")).json();
    expect(settings).not.toHaveProperty("workingDirectory");
    expect(settings.schemaVersion).toBe(2);
    expect(settings.defaultProject).toBeNull();
  });

  it("sets and clears defaultProject, and rejects an unknown one", async () => {
    await call("/api/projects", post({ workingDirectory: await repo("a") }));
    expect(
      (await (await call("/api/settings", put({ defaultProject: "a" }))).json()).defaultProject,
    ).toBe("a");
    expect((await call("/api/settings", put({ defaultProject: "ghost" }))).status).toBe(404);
    expect((await call("/api/settings", put({ defaultProject: "Bad Id" }))).status).toBe(400);
    expect(
      (await (await call("/api/settings", put({ defaultProject: null }))).json()).defaultProject,
    ).toBeNull();
  });

  it("toggling the runner keeps runner.concurrency", async () => {
    await call("/api/settings", put({ runner: { concurrency: 3 } }));
    const s = await (await call("/api/settings", put({ runner: { enabled: true } }))).json();
    expect(s.runner).toEqual({ enabled: true, concurrency: 3 });
  });
});

describe("authorization: scopes and project restriction", () => {
  beforeEach(async () => {
    await call("/api/projects", post({ workingDirectory: await repo("a") }));
    await call("/api/projects", post({ workingDirectory: await repo("b") }));
    await call("/api/settings", put({ defaultProject: "b" }));
    peer = REMOTE;
  });

  it("project routes need projects:read / projects:write", async () => {
    const reader = await mint(["projects:read"]);
    const taskOnly = await mint(["tasks:read", "tasks:write"]);
    expect((await call("/api/projects", {}, reader)).status).toBe(200);
    expect((await call("/api/projects/a", {}, reader)).status).toBe(200);
    expect((await call("/api/projects/a/usage", {}, reader)).status).toBe(200);
    const denied = await call("/api/projects/a", put({ name: "x" }), reader);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("forbidden_scope");
    expect((await call("/api/projects", {}, taskOnly)).status).toBe(403);
    expect((await call("/api/projects", post({ workingDirectory: "/x" }), reader)).status).toBe(
      403,
    );
    expect((await call("/api/projects/a/archive", post(), reader)).status).toBe(403);
    expect((await call("/api/projects/a/pause", post(), reader)).status).toBe(403);
    expect((await call("/api/projects/a", send("DELETE"), reader)).status).toBe(403);
    // Task routes keep their task scopes.
    expect((await call("/api/projects/a/tasks", {}, taskOnly)).status).toBe(200);
    expect((await call("/api/projects/a/tasks", {}, reader)).status).toBe(403);
    // Pausing is allowed with runner:control.
    const control = await mint(["runner:control"]);
    expect((await call("/api/projects/a/pause", post(), control)).status).toBe(200);
  });

  it("403 forbidden_project on every route of a project the client may not use", async () => {
    const key = await mint(
      ["projects:read", "projects:write", "tasks:read", "tasks:write", "tasks:control"],
      ["a"],
    );
    const attempts: [string, RequestInit][] = [
      ["/api/projects/b", {}],
      ["/api/projects/b", put({ name: "x" })],
      ["/api/projects/b", send("DELETE")],
      ["/api/projects/b/archive", post()],
      ["/api/projects/b/usage", {}],
      ["/api/projects/b/tasks", {}],
      ["/api/projects/b/tasks", post({ title: "x" })],
      ["/api/projects/b/tasks/x", {}],
      ["/api/projects/b/tasks/reorder", post({ order: [] })],
      ["/api/projects/b/tasks/x/stop", post()],
      ["/api/projects/b/tasks/x/attachments/y.png", {}],
    ];
    for (const [path, init] of attempts) {
      const res = await call(path, init, key);
      expect(res.status, `${init.method ?? "GET"} ${path}`).toBe(403);
      expect((await res.json()).error.code).toBe("forbidden_project");
    }
    // The allowed project works, and the forbidden check precedes the 404 (no existence probe).
    expect((await call("/api/projects/a/tasks", {}, key)).status).toBe(200);
    expect((await call("/api/projects/ghost/tasks", {}, key)).status).toBe(403);
    // The legacy alias points at b: forbidden too.
    const alias = await call("/api/tasks", {}, key);
    expect(alias.status).toBe(403);
    expect((await alias.json()).error.code).toBe("forbidden_project");
  });

  it("filters lists, usage and actions to the allowed projects", async () => {
    for (const pid of ["a", "b"]) {
      await writeFile(
        join(service.projects.dir(pid), "usage.json"),
        JSON.stringify({
          inputTokens: pid === "a" ? 1 : 100,
          outputTokens: 0,
          costUsd: 0,
          known: true,
        }),
      );
      await service.forProject(pid).create({ title: "Ask", status: "pending" });
      const tasks = service.forProject(pid).tasks;
      await tasks.transition("ask", "running");
      await tasks.transition("ask", "action", (t) => {
        t.frontmatter.questions = "pending";
      });
    }
    const key = await mint(["projects:read", "tasks:read"], ["a"]);
    expect(
      (await (await call("/api/projects", {}, key)).json()).projects.map((p: any) => p.id),
    ).toEqual(["a"]);
    expect((await (await call("/api/usage", {}, key)).json()).inputTokens).toBe(1);
    const { actions } = await (await call("/api/actions", {}, key)).json();
    expect(actions.map((t: any) => t.projectId)).toEqual(["a"]);
    const all = await mint(["projects:read", "tasks:read"], "*", "all");
    expect((await (await call("/api/usage", {}, all)).json()).inputTokens).toBe(101);
    expect((await (await call("/api/actions", {}, all)).json()).actions).toHaveLength(2);
  });

  it("a client restricted to a project cannot pass the settings default to a hidden project", async () => {
    // Setting the default is a settings:write operation, which this key lacks.
    const key = await mint(["projects:read"], ["a"]);
    expect((await call("/api/settings", put({ defaultProject: "a" }), key)).status).toBe(403);
  });
});

describe("project registration by non-local principals (project_root_not_allowed)", () => {
  let allowedRoot: string;
  let writer: string;
  beforeEach(async () => {
    allowedRoot = join(base, "allowed");
    await mkdir(allowedRoot, { recursive: true });
    peer = REMOTE;
    writer = await mint(["projects:write", "projects:read"]);
  });

  const create = (dir: string, key = writer) =>
    call("/api/projects", post({ workingDirectory: dir }), key);

  it("is forbidden when allowedProjectRoots is empty, but the local principal may register", async () => {
    const dir = await repo("app");
    const res = await create(dir);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("project_root_not_allowed");
    peer = LOOPBACK;
    expect((await call("/api/projects", post({ workingDirectory: dir }))).status).toBe(200);
  });

  it("accepts a git repository under an allowed root and records the client as origin", async () => {
    await setSecurity({ allowedProjectRoots: [allowedRoot] });
    const dir = await repo("ok", { parent: allowedRoot });
    const res = await create(dir);
    expect(res.status).toBe(200);
    expect((await res.json()).origin).toMatchObject({ kind: "api", client: "c" });
  });

  it("rejects a path outside the allowed roots, also via a symlink out of them", async () => {
    await setSecurity({ allowedProjectRoots: [allowedRoot] });
    const outside = await repo("outside");
    expect((await create(outside)).status).toBe(403);
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, join(allowedRoot, "link"));
    expect((await create(join(allowedRoot, "link"))).status).toBe(403);
    // `..` segments resolve before the check.
    expect((await create(join(allowedRoot, "..", "repos", "outside"))).status).toBe(403);
  });

  it("rejects a non-git directory and a directory inside the data root", async () => {
    await setSecurity({ allowedProjectRoots: [allowedRoot, base] });
    const plain = await repo("plain", { git: false, parent: allowedRoot });
    const notGit = await create(plain);
    expect(notGit.status).toBe(403);
    expect((await notGit.json()).error.code).toBe("project_root_not_allowed");
    const inside = join(root, "inner");
    await mkdir(inside);
    await execCommand("git", ["init", "-q"], { cwd: inside });
    expect((await create(inside)).status).toBe(403);
  });

  it("never accepts / or the home directory, even when they are under an allowed root", async () => {
    await setSecurity({ allowedProjectRoots: ["/"] });
    expect((await create("/")).status).toBe(403);
    expect((await create(homedir())).status).toBe(403);
  });

  it("expands ~ in allowed roots", async () => {
    const home = process.env.HOME;
    const fakeHome = join(base, "home");
    await mkdir(join(fakeHome, "codes"), { recursive: true });
    process.env.HOME = fakeHome;
    try {
      await setSecurity({ allowedProjectRoots: ["~/codes"] });
      const dir = await repo("app", { parent: join(fakeHome, "codes") });
      expect((await create(dir)).status).toBe(200);
      expect((await create(await repo("elsewhere"))).status).toBe(403);
    } finally {
      process.env.HOME = home;
    }
  });

  it("lists the allowed roots in the error only for admins", async () => {
    await setSecurity({ allowedProjectRoots: [allowedRoot] });
    const outside = await repo("outside");
    const plain = await (await create(outside)).json();
    expect(plain.error.details).toBeUndefined();
    const admin = await mint(["admin"], "*", "root");
    const adminRes = await create(outside, admin);
    expect(adminRes.status).toBe(403);
    expect((await adminRes.json()).error.details).toEqual({ allowedRoots: [allowedRoot] });
  });

  it("applies the same restriction when a client moves a project's working directory", async () => {
    await setSecurity({ allowedProjectRoots: [allowedRoot] });
    const dir = await repo("ok", { parent: allowedRoot });
    await create(dir);
    const outside = await repo("outside");
    const res = await call("/api/projects/ok", put({ workingDirectory: outside }), writer);
    expect(res.status).toBe(403);
    expect((await call("/api/projects/ok", put({ name: "fine" }), writer)).status).toBe(200);
  });
});

describe("SSE", () => {
  async function readEvents(res: Response, n: number): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (text.match(/\n\n/g) ?? []).length < n) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    return text;
  }

  it("sends the changed payload as JSON ({project} or {})", async () => {
    const res = await call("/api/events");
    setTimeout(() => {
      watcher.broadcast("changed", { project: "a" });
      watcher.broadcast("changed", {});
    }, 50);
    const text = await readEvents(res, 3);
    expect(text).toContain("event: ready");
    expect(text).toContain('event: changed\ndata: {"project":"a"}');
    expect(text).toContain("event: changed\ndata: {}");
  });

  it("does not leak other projects' events to a restricted client", async () => {
    await call("/api/projects", post({ workingDirectory: await repo("a") }));
    peer = REMOTE;
    const key = await mint(["tasks:read"], ["a"]);
    const res = await call("/api/events", {}, key);
    setTimeout(() => {
      watcher.broadcast("changed", { project: "b" });
      watcher.broadcast("changed", { project: "a" });
    }, 50);
    const text = await readEvents(res, 2);
    expect(text).toContain('"project":"a"');
    expect(text).not.toContain('"project":"b"');
  });
});
