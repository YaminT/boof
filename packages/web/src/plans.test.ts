import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthStore,
  defaultSettings,
  serializeGoal,
  SettingsStore,
  type Scope,
} from "@boof-runner/shared";
import { execCommand, MockTool, ToolRegistry } from "@boof-runner/runner";
import { createApp } from "./app.js";
import { TaskService } from "./service.js";

let base: string;
let root: string;
let repo: string;
let service: TaskService;
let authStore: AuthStore;
let peer: string;
let app: ReturnType<typeof createApp>;

const LOOPBACK = "127.0.0.1";
const REMOTE = "10.1.2.3";
const P = "/api/projects/demo/plans";

const call = (path: string, init: RequestInit = {}, key?: string) =>
  app.request("http://localhost" + path, {
    ...init,
    headers: { ...(init.headers as object), ...(key ? { authorization: `Bearer ${key}` } : {}) },
  });
const send = (
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function mint(
  scopes: Scope[],
  trust: "trusted" | "review" = "trusted",
  projects: string[] | "*" = "*",
) {
  return (await authStore.create({ name: "c", scopes, trust, projects })).key;
}

const spec = (goal: string) => ({
  goal,
  stack: "TypeScript",
  rules: { do: ["Write a failing test first."] },
  tests: { strategy: "TDD", technology: "vitest", run: "npm test" },
});
const goal = (id: string, deps: string[] = [], text = `Build ${id}`) => ({
  id,
  title: id.toUpperCase(),
  dependsOn: deps,
  spec: spec(text),
});
const threeGoals = () => [goal("a"), goal("b", ["a"]), goal("c")];

async function createPlan(body: Record<string, unknown> = {}, key?: string) {
  const res = await call(
    P,
    send("POST", { title: "Demo plan", status: "active", goals: threeGoals(), ...body }),
    key,
  );
  return { res, json: await res.json() };
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-runner-plans-web-")));
  root = join(base, "data");
  await mkdir(root, { recursive: true });
  repo = join(base, "repo");
  await mkdir(repo, { recursive: true });
  await execCommand("git", ["init", "-q"], { cwd: repo });
  repo = await realpath(repo);
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  await new SettingsStore(root).save(defaultSettings());
  await service.projects.create({ workingDirectory: repo, id: "demo" });
  authStore = new AuthStore(root);
  peer = LOOPBACK;
  app = createApp({ service, authStore, peerAddress: () => peer });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("plan CRUD", () => {
  it("creates, lists, gets and updates a plan; the ETag carries the version", async () => {
    const { res, json } = await createPlan();
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"1"');
    expect(json).toMatchObject({
      id: "demo-plan",
      status: "active",
      version: 1,
      source: { kind: "ui" },
    });
    expect(json.goals.map((g: { id: string; order: number }) => [g.id, g.order])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);

    const list = await (await call(P)).json();
    expect(list.plans).toHaveLength(1);
    expect(list.plans[0]).toMatchObject({ goalCount: 3, doneCount: 0 });
    expect(list.plans[0].goals).toBeUndefined();

    const got = await call(`${P}/demo-plan`);
    expect(got.headers.get("etag")).toBe('"1"');
    const upd = await call(`${P}/demo-plan`, send("PUT", { title: "Renamed", autoSync: true }));
    expect(await upd.json()).toMatchObject({ title: "Renamed", autoSync: true, version: 2 });
  });

  it("404 for an unknown plan or project; 400 for bad ids", async () => {
    expect((await call(`${P}/nope`)).status).toBe(404);
    expect((await (await call(`${P}/nope`)).json()).error.code).toBe("plan_not_found");
    expect((await call("/api/projects/ghost/plans")).status).toBe(404);
    expect((await call(`${P}/Bad_Id`)).status).toBe(400);
    expect((await call(`${P}/demo-plan/goals/Bad_Id`, send("PUT", goal("x")))).status).toBe(400);
  });

  it("409 plan_exists for a duplicate id", async () => {
    await createPlan({ id: "dup" });
    const again = await createPlan({ id: "dup" });
    expect(again.res.status).toBe(409);
    expect(again.json.error.code).toBe("plan_exists");
  });

  it("400 invalid_plan with details for a cycle, an unknown dependency and a bad spec", async () => {
    const cycle = await createPlan({ goals: [goal("a", ["b"]), goal("b", ["a"])] });
    expect(cycle.res.status).toBe(400);
    expect(cycle.json.error.code).toBe("invalid_plan");
    expect(cycle.json.error.details[0].message).toContain("cycle");
    const unknown = await createPlan({ id: "u", goals: [goal("a", ["ghost"])] });
    expect(unknown.json.error.details[0].message).toContain("ghost");
    const bad = await createPlan({
      id: "v",
      goals: [{ id: "a", title: "A", spec: { goal: "x" } }],
    });
    expect(bad.json.error.code).toBe("invalid_plan");
    expect(bad.json.error.details.length).toBeGreaterThan(0);
    const escape = await createPlan({ id: "w", goals: [{ ...goal("a"), path: "../etc" }] });
    expect(escape.json.error.code).toBe("invalid_plan");
  });
});

describe("goals", () => {
  it("PUT goals replaces the DAG and bumps the revision only of changed goals", async () => {
    await createPlan({ id: "p" });
    const res = await call(
      `${P}/p/goals`,
      send("PUT", {
        goals: [goal("a", [], "Build a v2"), goal("b", ["a"]), goal("c")],
      }),
    );
    const plan = await res.json();
    const rev = Object.fromEntries(
      plan.goals.map((g: { id: string; revision: number }) => [g.id, g.revision]),
    );
    expect(rev).toEqual({ a: 2, b: 1, c: 1 });
    expect(plan.version).toBe(2);
    // Dropping a goal removes it.
    const dropped = await (await call(`${P}/p/goals`, send("PUT", { goals: [goal("a")] }))).json();
    expect(dropped.goals.map((g: { id: string }) => g.id)).toEqual(["a"]);
  });

  it("PUT goals/:goalId upserts; the body id must match", async () => {
    await createPlan({ id: "p" });
    const added = await call(`${P}/p/goals/d`, send("PUT", { ...goal("d", ["a"]), id: undefined }));
    expect((await added.json()).goals.map((g: { id: string }) => g.id)).toContain("d");
    const mismatch = await call(`${P}/p/goals/d`, send("PUT", goal("zzz")));
    expect(mismatch.status).toBe(400);
  });

  it("DELETE goal: 409 with dependents unless cascade", async () => {
    await createPlan({ id: "p" });
    const refused = await call(`${P}/p/goals/a`, { method: "DELETE" });
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body.error.code).toBe("goal_has_dependents");
    expect(body.error.details.dependents).toEqual(["b"]);
    const ok = await (await call(`${P}/p/goals/a?cascade=1`, { method: "DELETE" })).json();
    expect(ok.goals.map((g: { id: string }) => g.id)).toEqual(["c"]);
    expect((await call(`${P}/p/goals/zzz`, { method: "DELETE" })).status).toBe(404);
  });

  it("reorder accepts a topological order only", async () => {
    await createPlan({ id: "p" });
    const bad = await call(`${P}/p/reorder`, send("POST", { order: ["b", "a", "c"] }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_plan");
    const ok = await (
      await call(`${P}/p/reorder`, send("POST", { order: ["c", "a", "b"] }))
    ).json();
    expect(ok.goals.map((g: { id: string }) => g.id)).toEqual(["c", "a", "b"]);
  });

  it("sets a goal status and records it in the history", async () => {
    await createPlan({ id: "p" });
    const res = await call(
      `${P}/p/goals/a/status`,
      send("POST", { status: "review", description: "looks fine" }),
    );
    const g = (await res.json()).goals.find((x: { id: string }) => x.id === "a");
    expect(g.status).toBe("review");
    expect(g.history.at(-1)).toMatchObject({ status: "review", description: "looks fine" });
  });
});

describe("optimistic concurrency", () => {
  it("a stale If-Match is 409 plan_version_conflict with the current version", async () => {
    await createPlan({ id: "p" });
    await call(`${P}/p`, send("PUT", { title: "One" }, { "If-Match": '"1"' }));
    const stale = await call(`${P}/p`, send("PUT", { title: "Two" }, { "If-Match": '"1"' }));
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.error.code).toBe("plan_version_conflict");
    expect(body.error.details.currentVersion).toBe(2);
    expect(await (await call(`${P}/p`)).json()).toMatchObject({ title: "One" });
  });

  it("body expectedVersion works too, and a matching one succeeds", async () => {
    await createPlan({ id: "p" });
    const stale = await call(
      `${P}/p/goals`,
      send("PUT", { goals: [goal("a")], expectedVersion: 5 }),
    );
    expect(stale.status).toBe(409);
    const ok = await call(`${P}/p/goals`, send("PUT", { goals: [goal("a")], expectedVersion: 1 }));
    expect(ok.status).toBe(200);
    expect(
      (await call(`${P}/p/goals/a`, { method: "DELETE", headers: { "If-Match": "1" } })).status,
    ).toBe(409);
    expect((await call(`${P}/p`, send("PUT", { title: "x" }, { "If-Match": "abc" }))).status).toBe(
      400,
    );
  });
});

describe("sync", () => {
  it("creates one pending task, rewrites it after a goal change, and is idempotent", async () => {
    await createPlan({ id: "p" });
    const first = await (await call(`${P}/p/sync`, send("POST", {}))).json();
    expect(first.created.map((c: { goalId: string }) => c.goalId)).toEqual(["a", "c"]);
    expect(first.skipped).toEqual([{ goalId: "b", reason: "blocked" }]);
    const tasks = (await (await call("/api/projects/demo/tasks")).json()).tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks[0].frontmatter.planRef.planId).toBe("p");

    expect((await (await call(`${P}/p/sync`, send("POST"))).json()).created).toEqual([]);

    await call(
      `${P}/p/goals/a`,
      send("PUT", { ...goal("a", [], "Build a differently"), id: undefined }),
    );
    const dry = await (await call(`${P}/p/sync`, send("POST", { dryRun: true }))).json();
    expect(dry.dryRun).toBe(true);
    expect(dry.updated[0]).toMatchObject({ goalId: "a", action: "rewritten", revision: 2 });
    const unchanged = (await (await call("/api/projects/demo/tasks/boof-a")).json()).body.prompt;
    expect(unchanged).not.toContain("differently");

    const real = await (await call(`${P}/p/sync`, send("POST"))).json();
    expect(real.updated[0].action).toBe("rewritten");
    const rewritten = (await (await call("/api/projects/demo/tasks/boof-a")).json()).body.prompt;
    expect(rewritten).toContain("Build a differently");
  });

  it("409 plan_not_active for a draft plan", async () => {
    await createPlan({ id: "p", status: "draft" });
    const res = await call(`${P}/p/sync`, send("POST", {}));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("plan_not_active");
  });

  it("editing the prompt of a plan task marks it manual", async () => {
    await createPlan({ id: "p" });
    await call(`${P}/p/sync`, send("POST", {}));
    await call("/api/projects/demo/tasks/boof-a", send("PUT", { prompt: "mine" }));
    const t = await (await call("/api/projects/demo/tasks/boof-a")).json();
    expect(t.frontmatter.promptSource).toBe("manual");
  });
});

describe("export and import", () => {
  it("exports a plan as a filename to content map", async () => {
    await createPlan({ id: "p", goals: [{ ...goal("a"), path: "units/a" }, goal("b", ["a"])] });
    const files = await (await call(`${P}/p/export`)).json();
    expect(Object.keys(files).sort()).toEqual([
      "b/goal.boof.xml",
      "plan.boof.xml",
      "units/a/goal.boof.xml",
    ]);
    expect(files["plan.boof.xml"]).toContain('id="a"');
  });

  it("imports the repository's goal files; 409 without merge, 200 with merge", async () => {
    await mkdir(join(repo, "core"), { recursive: true });
    await writeFile(
      join(repo, "core", "goal.boof.xml"),
      serializeGoal({
        overal: { goal: "Core", stack: "TS", rules: { do: ["x"], dont: [] } },
        progress: {
          versions: [{ number: 1, status: "plan", description: "seed" }],
          tests: { strategy: "TDD", technology: "vitest", run: "npm test" },
        },
      }),
      "utf8",
    );
    const first = await call(`${P}/import`, send("POST", {}));
    const body = await first.json();
    expect(body.plan).toMatchObject({
      id: "repo",
      status: "draft",
      source: { kind: "repo-import" },
    });
    expect(body.added).toEqual(["core"]);
    expect((await call(`${P}/import`, send("POST", {}))).status).toBe(409);
    const merged = await (await call(`${P}/import`, send("POST", { merge: true }))).json();
    expect(merged.unchanged).toEqual(["core"]);
  });

  it("400 nothing_to_import for a repo without goal files", async () => {
    const res = await call(`${P}/import`, send("POST", {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("nothing_to_import");
  });
});

describe("scopes and trust", () => {
  it("plans:read cannot write; no plans scope cannot read; project restriction applies", async () => {
    peer = REMOTE;
    const reader = await mint(["plans:read"]);
    const writer = await mint(["plans:write"]);
    const other = await mint(["plans:read", "plans:write"], "trusted", ["elsewhere"]);
    expect((await call(P, {}, reader)).status).toBe(200);
    expect((await call(P, send("POST", { title: "x" }), reader)).status).toBe(403);
    expect((await call(P, {}, writer)).status).toBe(403);
    expect((await call(P, {}, other)).status).toBe(403);
    expect((await call(P, send("POST", { title: "x" }), writer)).status).toBe(200);
  });

  it("a trusted client may create an active plan, with its client as the source", async () => {
    peer = REMOTE;
    const key = await mint(["plans:write", "plans:read"]);
    const { json } = await createPlan({ id: "t" }, key);
    expect(json.status).toBe("active");
    expect(json.source.client).toBeDefined();
  });

  it("a review client gets a draft plan, cannot activate it, and sync is 409 plan_not_active", async () => {
    peer = REMOTE;
    const key = await mint(["plans:write", "plans:read"], "review");
    const { json } = await createPlan({ id: "r", status: "active" }, key);
    expect(json.status).toBe("draft");
    const activate = await call(`${P}/r`, send("PUT", { status: "active" }), key);
    expect(activate.status).toBe(403);
    expect((await activate.json()).error.code).toBe("forbidden_trust");
    const sync = await call(`${P}/r/sync`, send("POST", {}), key);
    expect(sync.status).toBe(409);
    expect((await sync.json()).error.code).toBe("plan_not_active");
    // It can still edit its own draft.
    expect(
      (await call(`${P}/r/goals/a`, send("PUT", { ...goal("a", [], "v2"), id: undefined }), key))
        .status,
    ).toBe(200);
  });

  it("after a human approves, tasks of a review client's plan land in draft; the client cannot edit it", async () => {
    peer = REMOTE;
    const key = await mint(["plans:write", "plans:read"], "review");
    await createPlan({ id: "r" }, key);
    peer = LOOPBACK;
    await call(`${P}/r`, send("PUT", { status: "active" }));
    const sync = await (await call(`${P}/r/sync`, send("POST", {}))).json();
    expect(sync.created.every((c: { status: string }) => c.status === "draft")).toBe(true);
    const tasks = (await (await call("/api/projects/demo/tasks")).json()).tasks;
    expect(
      tasks.every((t: { frontmatter: { status: string } }) => t.frontmatter.status === "draft"),
    ).toBe(true);
    peer = REMOTE;
    const edit = await call(`${P}/r`, send("PUT", { title: "hack" }), key);
    expect(edit.status).toBe(403);
  });
});
