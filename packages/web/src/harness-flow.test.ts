/**
 * The harness flow of the roadmap (plans/README.md), end to end through /api/v1 with a bearer
 * key: create project, submit a plan with dependent goals, sync, let the runner execute with the
 * mock tool, change a goal, sync again and get a follow-up task.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, defaultSettings, SettingsStore } from "@boof-runner/shared";
import { execCommand, RunnerEngine, resetMock } from "@boof-runner/runner";
import { TaskService } from "@boof-runner/api";
import { createApp } from "./app.js";

let base: string;
let root: string;
let repo: string;
let app: ReturnType<typeof createApp>;
let key: string;

const call = (path: string, init: RequestInit = {}) =>
  app.request("http://localhost/api/v1" + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      ...(init.headers as object),
    },
  });
const send = (
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): RequestInit => ({
  method,
  headers,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

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

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-flow-")));
  root = join(base, "data");
  repo = join(base, "repos", "shop");
  await mkdir(repo, { recursive: true });
  const g = (args: string[]) => execCommand("git", args, { cwd: repo, timeoutMs: 15000 });
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "t@e.com"]);
  await g(["config", "user.name", "T"]);
  await writeFile(join(repo, "README.md"), "# shop\n");
  await g(["add", "."]);
  await g(["commit", "-m", "init"]);

  const settings = defaultSettings();
  settings.runner.enabled = true;
  settings.roles = {
    planner: { tool: "mock", model: "mock-default" },
    developer: { tool: "mock", model: "mock-default" },
    reviewer: { tool: "mock", model: "mock-default" },
  };
  settings.security = {
    allowedHosts: [],
    auth: { mode: "required" },
    allowedProjectRoots: [join(base, "repos")],
    externalTasksRequireApproval: true,
    rateLimit: { perMinute: 600, attachmentsPerMinute: 30 },
    audit: { enabled: true, retentionDays: 90 },
  };
  await new SettingsStore(root).save(settings);
  const authStore = new AuthStore(root);
  key = (
    await authStore.create({
      name: "harness",
      scopes: [
        "projects:write",
        "plans:write",
        "tasks:write",
        "tasks:read",
        "plans:read",
        "projects:read",
      ],
      trust: "trusted",
    })
  ).key;
  app = createApp({
    service: new TaskService(root),
    authStore,
    peerAddress: () => "10.0.0.7",
  });
  resetMock();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
  resetMock();
});

describe("harness flow over /api/v1", () => {
  it("project -> plan -> sync -> run -> goals done -> change a goal -> re-sync -> follow-up task", async () => {
    // 1-2. Register the repository, submit a plan with dependent goals.
    const project = await call("/projects", send("POST", { workingDirectory: repo, id: "shop" }));
    expect(project.status).toBe(201);
    const created = await call(
      "/projects/shop/plans",
      send("POST", {
        id: "q4",
        title: "Q4",
        status: "active",
        autoSync: true,
        goals: [goal("a"), goal("b", ["a"]), goal("c")],
      }),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe('"1"');

    // 3. Sync materialises one task per unblocked goal.
    const sync = await (await call("/projects/shop/plans/q4/sync", send("POST"))).json();
    expect(sync.created.map((c: { goalId: string }) => c.goalId).sort()).toEqual(["a", "c"]);
    expect(sync.skipped).toEqual([{ goalId: "b", reason: "blocked" }]);

    // 4. The runner executes with the mock tool; autoSync releases `b` once `a` is done.
    const engine = new RunnerEngine({ root, pollIntervalMs: 10 });
    await engine.runUntilIdle();
    const plan = await (await call("/projects/shop/plans/q4")).json();
    expect(plan.goals.map((g: { id: string; status: string }) => [g.id, g.status])).toEqual([
      ["a", "done"],
      ["b", "done"],
      ["c", "done"],
    ]);
    const tasks = await (await call("/projects/shop/tasks?status=done")).json();
    expect(tasks.items).toHaveLength(3);
    expect("log" in tasks.items[0].body).toBe(false);

    // 6. Requirements change: update goal `a` with the plan's ETag, then re-sync.
    const etag = (await call("/projects/shop/plans/q4")).headers.get("etag")!;
    const changed = await call(
      "/projects/shop/plans/q4/goals/a",
      send(
        "PUT",
        { title: "A", dependsOn: [], spec: spec("Build a, but with audit logging") },
        { "If-Match": etag },
      ),
    );
    expect(changed.status).toBe(200);
    const stale = await call(
      "/projects/shop/plans/q4/goals/a",
      send("PUT", { title: "A", spec: spec("again") }, { "If-Match": etag }),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("plan_version_conflict");

    const resync = await (await call("/projects/shop/plans/q4/sync", send("POST"))).json();
    expect(resync.created).toHaveLength(1);
    expect(resync.created[0]).toMatchObject({ goalId: "a", followUp: true });

    // 5. The history is in the events stream and the contract is published.
    const events = await app.request("http://localhost/api/v1/events?since=start", {
      headers: { authorization: `Bearer ${key}` },
    });
    const types = [...(await events.text()).matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(types).toContain("plan.synced");
    expect(types.filter((t) => t === "task.status").length).toBeGreaterThanOrEqual(6);
    expect((await call("/openapi.json")).status).toBe(200);
  });
});
