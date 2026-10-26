import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthStore,
  defaultSettings,
  ProjectStore,
  SettingsStore,
  TaskStore,
  type Scope,
} from "@boof-runner/shared";
import { execCommand, MockTool, ToolRegistry } from "@boof-runner/runner";
import { TaskService } from "@boof-runner/api";
import { createApp } from "./app.js";

let base: string;
let root: string;
let service: TaskService;
let authStore: AuthStore;
let peer: string;
let app: ReturnType<typeof createApp>;

const LOOPBACK = "127.0.0.1";
const REMOTE = "10.1.2.3";
const P = "/api/v1/projects/demo/plans";
const T = "/api/v1/projects/demo/tasks";

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
const json = async (res: Response) => res.json();

async function mint(scopes: Scope[], trust: "trusted" | "review") {
  return (await authStore.create({ name: "c", scopes, trust, projects: "*" })).key;
}

const spec = (goal: string) => ({
  goal,
  stack: "TypeScript",
  rules: { do: ["Write a failing test first."] },
  tests: { strategy: "TDD", technology: "vitest", run: "npm test" },
});
const goal = (id: string, deps: string[] = []) => ({
  id,
  title: id.toUpperCase(),
  dependsOn: deps,
  spec: spec(`Build ${id}`),
});
const goals = () => [goal("posts"), goal("rss", ["posts"]), goal("about")];

/** The three-goal plan of a review client; the human approves it (loopback = local principal). */
async function proposeAndApprove(reviewKey: string, id = "site"): Promise<void> {
  peer = REMOTE;
  const created = await call(
    P,
    send("POST", { id, title: "Site", status: "active", goals: goals() }),
    reviewKey,
  );
  expect(created.status).toBe(201);
  peer = LOOPBACK;
  const approved = await call(`${P}/${id}`, send("PUT", { status: "active" }));
  expect(approved.status).toBe(200);
}

async function finishGoal(planId: string, goalId: string): Promise<void> {
  const res = await call(`${P}/${planId}/goals/${goalId}/status`, send("POST", { status: "done" }));
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-approval-")));
  root = join(base, "data");
  await mkdir(root, { recursive: true });
  const repo = join(base, "repo");
  await mkdir(repo, { recursive: true });
  await execCommand("git", ["init", "-q"], { cwd: repo });
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  await new SettingsStore(root).save(defaultSettings());
  await service.projects.create({ workingDirectory: await realpath(repo), id: "demo" });
  authStore = new AuthStore(root);
  peer = LOOPBACK;
  app = createApp({ service, authStore, peerAddress: () => peer });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("approval of a plan approves its tasks", () => {
  it("records approvedBy when a human activates a review client's plan", async () => {
    const key = await mint(["plans:write", "plans:read"], "review");
    peer = REMOTE;
    await call(P, send("POST", { id: "site", title: "Site", goals: goals() }), key);
    peer = LOOPBACK;
    const before = await json(await call(`${P}/site`));
    expect(before.approvedBy).toBeUndefined();
    const after = await json(await call(`${P}/site`, send("PUT", { status: "active" })));
    expect(after.status).toBe("active");
    expect(after.approvedBy).toMatchObject({ principalId: "local", version: after.version });
    expect(typeof after.approvedBy.at).toBe("string");
  });

  it("creates pending tasks per dependency layer for a review client's approved plan", async () => {
    const key = await mint(["plans:write", "plans:read", "tasks:read"], "review");
    await proposeAndApprove(key);
    const first = await json(await call(`${P}/site/sync`, send("POST", {})));
    expect(
      first.created.map((c: { goalId: string; status: string }) => [c.goalId, c.status]),
    ).toEqual([
      ["posts", "pending"],
      ["about", "pending"],
    ]);
    await finishGoal("site", "posts");
    const second = await json(await call(`${P}/site/sync`, send("POST", {})));
    expect(
      second.created.map((c: { goalId: string; status: string }) => [c.goalId, c.status]),
    ).toEqual([["rss", "pending"]]);
    const tasks = (await json(await call(T))).items;
    expect(
      tasks.every((t: { frontmatter: { status: string } }) => t.frontmatter.status === "pending"),
    ).toBe(true);
  });

  it("lets the review client itself call sync on an approved plan; tasks are pending", async () => {
    const key = await mint(["plans:write", "plans:read", "tasks:read"], "review");
    await proposeAndApprove(key);
    peer = REMOTE;
    const sync = await json(await call(`${P}/site/sync`, send("POST", {}), key));
    expect(sync.created.every((c: { status: string }) => c.status === "pending")).toBe(true);
  });

  it("keeps the approval when a trusted principal edits the plan; clears it on draft", async () => {
    const key = await mint(["plans:write", "plans:read"], "review");
    await proposeAndApprove(key);
    const approved = await json(await call(`${P}/site`));
    const renamed = await json(await call(`${P}/site`, send("PUT", { title: "Renamed" })));
    expect(renamed.approvedBy).toEqual(approved.approvedBy);
    const again = await json(await call(`${P}/site`, send("PUT", { status: "active" })));
    expect(again.approvedBy).toEqual(approved.approvedBy);
    const goalsEdit = await json(
      await call(
        `${P}/site/goals/about`,
        send("PUT", { ...goal("about"), spec: spec("About v2"), id: undefined }),
      ),
    );
    expect(goalsEdit.approvedBy).toEqual(approved.approvedBy);
    const draft = await json(await call(`${P}/site`, send("PUT", { status: "draft" })));
    expect(draft.status).toBe("draft");
    expect(draft.approvedBy).toBeUndefined();
    const reactivated = await json(await call(`${P}/site`, send("PUT", { status: "active" })));
    expect(reactivated.approvedBy.version).toBe(reactivated.version);
    const archived = await json(await call(`${P}/site`, send("PUT", { status: "archived" })));
    expect(archived.approvedBy).toBeUndefined();
  });

  it("a plan that goes back to draft cannot be synced", async () => {
    const key = await mint(["plans:write", "plans:read"], "review");
    await proposeAndApprove(key);
    await call(`${P}/site`, send("PUT", { status: "draft" }));
    peer = REMOTE;
    const sync = await call(`${P}/site/sync`, send("POST", {}), key);
    expect(sync.status).toBe(409);
  });

  it("a trusted client that creates an active plan approves it at once", async () => {
    const key = await mint(["plans:write", "plans:read"], "trusted");
    peer = REMOTE;
    const plan = await json(
      await call(P, send("POST", { id: "t", title: "T", status: "active", goals: goals() }), key),
    );
    expect(plan.approvedBy).toMatchObject({ version: 1 });
  });

  it("a review client cannot change goals of an approved plan in any way", async () => {
    const key = await mint(["plans:write", "plans:read"], "review");
    await proposeAndApprove(key);
    peer = REMOTE;
    const version = (await json(await call(`${P}/site`, {}, key))).version;
    const attempts: [string, string, unknown][] = [
      ["PUT", `${P}/site`, { title: "x" }],
      ["PUT", `${P}/site/goals`, { goals: [goal("posts")] }],
      ["PUT", `${P}/site/goals/about`, { ...goal("about"), spec: spec("evil"), id: undefined }],
      ["DELETE", `${P}/site/goals/about`, undefined],
      ["POST", `${P}/site/reorder`, { order: ["about", "posts", "rss"] }],
      ["POST", `${P}/site/goals/about/status`, { status: "done" }],
      ["POST", `${P}/import`, { planId: "site", merge: true }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(path, send(method, body), key);
      expect([method, path, res.status, (await res.json()).error?.code]).toEqual([
        method,
        path,
        403,
        "forbidden_trust",
      ]);
    }
    expect((await json(await call(`${P}/site`, {}, key))).version).toBe(version);
  });

  it("a review client cannot rewrite the prompt of a pending plan task", async () => {
    const key = await mint(["plans:write", "plans:read", "tasks:write", "tasks:read"], "review");
    await proposeAndApprove(key);
    await call(`${P}/site/sync`, send("POST", {}));
    peer = REMOTE;
    const res = await call(`${T}/boof-posts`, send("PUT", { prompt: "do something else" }), key);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_trust");
    const stored = await new TaskStore(new ProjectStore(root).dir("demo")).get("boof-posts");
    expect(stored!.body.prompt).not.toContain("something else");
  });

  it("ad-hoc tasks of a review client stay drafts", async () => {
    const key = await mint(["tasks:write", "tasks:read"], "review");
    peer = REMOTE;
    const task = await json(
      await call(T, send("POST", { title: "Idea", prompt: "p", status: "pending" }), key),
    );
    expect(task.frontmatter.status).toBe("draft");
  });

  it("externalTasksRequireApproval=false: unchanged, tasks are pending without approval", async () => {
    const settings = await new SettingsStore(root).load();
    await new SettingsStore(root).save({
      ...settings,
      security: { ...settings.security!, externalTasksRequireApproval: false },
    });
    const key = await mint(["plans:write", "plans:read"], "review");
    peer = REMOTE;
    const plan = await json(
      await call(
        P,
        send("POST", { id: "free", title: "Free", status: "active", goals: goals() }),
        key,
      ),
    );
    expect(plan.status).toBe("active");
    expect(plan.approvedBy).toBeDefined();
    const sync = await json(await call(`${P}/free/sync`, send("POST", {}), key));
    expect(sync.created.every((c: { status: string }) => c.status === "pending")).toBe(true);
  });
});

describe("status_downgraded warnings", () => {
  it("plan create: body warning and Boof-Warning header for a review client", async () => {
    const key = await mint(["plans:write", "plans:read"], "review");
    peer = REMOTE;
    const res = await call(
      P,
      send("POST", { id: "w", title: "W", status: "active", goals: goals() }),
      key,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("boof-warning")).toBe("status_downgraded");
    const body = await res.json();
    expect(body.status).toBe("draft");
    expect(body.warnings).toEqual([
      expect.objectContaining({
        code: "status_downgraded",
        field: "status",
        requested: "active",
        applied: "draft",
        message: expect.stringContaining("Plans tab"),
      }),
    ]);
  });

  it("task create: warning when pending is downgraded to draft", async () => {
    const key = await mint(["tasks:write", "tasks:read"], "review");
    peer = REMOTE;
    const res = await call(T, send("POST", { title: "Idea", status: "pending" }), key);
    expect(res.headers.get("boof-warning")).toBe("status_downgraded");
    const body = await res.json();
    expect(body.frontmatter.status).toBe("draft");
    expect(body.warnings[0]).toMatchObject({
      requested: "pending",
      applied: "draft",
      field: "status",
    });
  });

  it("no warning when nothing was changed", async () => {
    const key = await mint(["tasks:write", "plans:write", "tasks:read"], "review");
    peer = REMOTE;
    const task = await call(T, send("POST", { title: "Idea" }), key);
    expect(task.headers.get("boof-warning")).toBeNull();
    expect((await task.json()).warnings).toBeUndefined();
    const plan = await call(P, send("POST", { title: "Plain" }), key);
    expect(plan.headers.get("boof-warning")).toBeNull();
    peer = LOOPBACK;
    const human = await call(T, send("POST", { title: "Mine", status: "pending" }));
    expect(human.headers.get("boof-warning")).toBeNull();
    expect((await human.json()).frontmatter.status).toBe("pending");
  });
});

describe("structured reviews and live-log text", () => {
  async function seedReviewedTask(): Promise<void> {
    const store = new TaskStore(new ProjectStore(root).dir("demo"));
    const { newTask } = await import("@boof-runner/shared");
    const task = newTask(
      {
        id: "rev",
        title: "Reviewed",
        status: "draft",
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
      },
      "p",
    );
    task.body.reports.observer = "#### Round 1 — APPROVE\nObserver likes it.\nVERDICT: APPROVE";
    task.body.reports.reviewer = [
      "#### Round 1 — CHANGES_REQUESTED\n## Findings\n\nMissing a test.\nVERDICT: CHANGES_REQUESTED",
      "#### Round 2 — APPROVE\nAll good now.\nVERDICT: APPROVE",
    ].join("\n\n");
    task.body.log =
      "Iteration 1/1 — worktree at /x\n\nbase main → 0123456789abcdef0123456789abcdef01234567";
    await store.create(task);
  }

  it("GET task carries reviews, finalVerdict, branch and baseSha", async () => {
    await seedReviewedTask();
    const t = await json(await call(`${T}/rev`));
    expect(t.reviews).toEqual([
      {
        role: "observer",
        round: 1,
        iteration: 1,
        verdict: "APPROVE",
        summary: "Observer likes it.",
      },
      {
        role: "reviewer",
        round: 1,
        iteration: 1,
        verdict: "CHANGES_REQUESTED",
        summary: "Missing a test.",
      },
      { role: "reviewer", round: 2, iteration: 1, verdict: "APPROVE", summary: "All good now." },
    ]);
    expect(t.finalVerdict).toEqual({ observer: "APPROVE", reviewer: "APPROVE" });
    expect(t.branch).toBe("boof-runner/rev");
    expect(t.baseSha).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(t.body).not.toHaveProperty("log");
  });

  it("a task that never ran has empty reviews and no branch", async () => {
    const created = await json(await call(T, send("POST", { title: "Fresh" })));
    expect(created.reviews).toEqual([]);
    expect(created.finalVerdict).toEqual({});
    expect(created.branch).toBeUndefined();
  });

  it("live-log keeps its JSON shape and returns text/plain with ?format=text", async () => {
    await seedReviewedTask();
    const asJson = await call(`${T}/rev/live-log`);
    expect(asJson.headers.get("content-type")).toContain("application/json");
    const body = await asJson.json();
    expect(Object.keys(body).sort()).toEqual(["log", "running"]);
    const text = await call(`${T}/rev/live-log?format=text`);
    expect(text.status).toBe(200);
    expect(text.headers.get("content-type")).toContain("text/plain");
    expect(await text.text()).toBe(body.log);
    const explicit = await call(`${T}/rev/live-log?format=json`);
    expect(explicit.headers.get("content-type")).toContain("application/json");
    expect((await call(`${T}/rev/live-log?format=xml`)).status).toBe(400);
  });
});
