/**
 * The harness flow of the roadmap (plans/README.md), end to end through /api/v1 with a bearer
 * key: create project, submit a plan with dependent goals, sync, let the runner execute with the
 * mock tool, change a goal, sync again and get a follow-up task.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthStore,
  defaultSettings,
  ProjectStore,
  SettingsStore,
  TaskStore,
} from "@boof-runner/shared";
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
        "tasks:control",
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
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    // A done goal whose spec changed is open again at once, before any sync.
    const reopened = (await (await call("/projects/shop/plans/q4")).json()).goals.find(
      (g: { id: string }) => g.id === "a",
    );
    expect(reopened.status).toBe("develop");
    expect(reopened.history.at(-1)).toMatchObject({
      status: "develop",
      description: "spec changed to revision 2",
    });
    const stale = await call(
      "/projects/shop/plans/q4/goals/a",
      send("PUT", { title: "A", spec: spec("again") }, { "If-Match": etag }),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("plan_version_conflict");

    const resync = await (await call("/projects/shop/plans/q4/sync", send("POST"))).json();
    expect(resync.created).toHaveLength(1);
    expect(resync.created[0]).toMatchObject({ goalId: "a", followUp: true });

    // The follow-up builds on the first task's branch and the goal lists both tasks.
    const followUp = await (await call(`/projects/shop/tasks/${resync.created[0].taskId}`)).json();
    expect(followUp.frontmatter.base).toBe("boof-runner/boof-a");
    await engine.runUntilIdle();
    const after = await (await call("/projects/shop/plans/q4")).json();
    const a = after.goals.find((g: { id: string }) => g.id === "a");
    expect(a.status).toBe("done");
    expect(a.tasks).toEqual([
      { taskId: "boof-a", revision: 1, status: "done", branch: "boof-runner/boof-a" },
      {
        taskId: resync.created[0].taskId,
        revision: 2,
        status: "done",
        branch: `boof-runner/${resync.created[0].taskId}`,
      },
    ]);
    expect(a.history.at(-1)).toMatchObject({ status: "done", taskId: resync.created[0].taskId });
    expect(after.mergeOrder.map((m: { goalId: string }) => m.goalId)).toContain("a");
    expect(after.mergeOrder.find((m: { goalId: string }) => m.goalId === "a")).toEqual({
      goalId: "a",
      taskId: resync.created[0].taskId,
      branch: `boof-runner/${resync.created[0].taskId}`,
    });
    const fu = await (await call(`/projects/shop/tasks/${resync.created[0].taskId}`)).json();
    expect(fu).toMatchObject({ baseRef: "boof-runner/boof-a", baseReason: "follow-up" });
    expect(fu.baseSha).toMatch(/^[0-9a-f]{7,}$/);
    const whole = await (await call("/projects/shop/plans/q4/wait?timeoutSeconds=1")).json();
    expect(whole).toMatchObject({
      complete: true,
      stuck: false,
      stuckReasons: [],
      timedOut: false,
    });
    const doneWait = await (await call(`/projects/shop/tasks/boof-a/wait?timeoutSeconds=5`)).json();
    expect(doneWait).toMatchObject({ changed: false, timedOut: false, terminal: true });

    // 5. The history is in the events stream and the contract is published.
    const events = await app.request("http://localhost/api/v1/events?since=start", {
      headers: { authorization: `Bearer ${key}` },
    });
    const types = [...(await events.text()).matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(types).toContain("plan.synced");
    expect(types.filter((t) => t === "task.status").length).toBeGreaterThanOrEqual(6);
    expect((await call("/openapi.json")).status).toBe(200);
  });

  it("wait: tasks and plans return at once when there is nothing to wait for", async () => {
    await call("/projects", send("POST", { workingDirectory: repo, id: "shop" }));
    await call(
      "/projects/shop/plans",
      send("POST", {
        id: "w",
        title: "W",
        status: "active",
        goals: [goal("a"), goal("b", ["a"])],
      }),
    );
    // Not synced yet: no task can run, so the plan is stuck with a reason per goal.
    const unsynced = await (await call("/projects/shop/plans/w/wait?timeoutSeconds=1")).json();
    expect(unsynced).toMatchObject({ complete: false, stuck: true, timedOut: false });
    expect(unsynced.stuckReasons).toEqual([
      { goalId: "a", taskId: null, status: "no-task" },
      { goalId: "b", taskId: null, status: "blocked" },
    ]);

    // A plan the engine syncs by itself is not stuck while it waits for its first sync;
    // a draft plan has no way forward at all.
    await call(
      "/projects/shop/plans",
      send("POST", {
        id: "auto",
        title: "Auto",
        status: "active",
        autoSync: true,
        goals: [goal("x")],
      }),
    );
    const auto = await (await call("/projects/shop/plans/auto/wait?timeoutSeconds=1")).json();
    expect(auto).toMatchObject({ stuck: false, timedOut: true });
    await call(
      "/projects/shop/plans",
      send("POST", { id: "idea", title: "Idea", goals: [goal("y")] }),
    );
    const draft = await (await call("/projects/shop/plans/idea/wait?timeoutSeconds=1")).json();
    expect(draft).toMatchObject({ stuck: true, awaitingApproval: true, timedOut: false });
    expect(draft.stuckReasons).toEqual([{ goalId: "", taskId: null, status: "plan-not-active" }]);
    expect(auto.awaitingApproval).toBe(false);
    expect(unsynced.awaitingApproval).toBe(false);

    // Synced, runner idle: tasks are draft (review is off here, so pending) and the plan waits.
    await call("/projects/shop/plans/w/sync", send("POST"));
    const sinceNow = unsynced.version;
    const bumped = await (
      await call(`/projects/shop/plans/w/wait?sinceVersion=${sinceNow}&timeoutSeconds=1`)
    ).json();
    expect(bumped).toMatchObject({ changed: true, stuck: false, complete: false });
    const idle = await (
      await call(`/projects/shop/plans/w/wait?sinceVersion=${bumped.version}&timeoutSeconds=1`)
    ).json();
    expect(idle).toMatchObject({ changed: false, timedOut: true, stuck: false });

    // A pending task: wait times out, or returns at once when it already is the `until` status.
    const pending = await (await call("/projects/shop/tasks/boof-a/wait?timeoutSeconds=1")).json();
    expect(pending).toMatchObject({ changed: false, timedOut: true, terminal: false });
    const until = await (
      await call("/projects/shop/tasks/boof-a/wait?until=pending&timeoutSeconds=30")
    ).json();
    expect(until).toMatchObject({ changed: false, timedOut: false, terminal: false });

    // A failed task stops the plan and ends the task wait.
    const store = new TaskStore(new ProjectStore(root).dir("shop"));
    await store.transition("boof-a", "running");
    await store.transition("boof-a", "failed");
    const failed = await (await call("/projects/shop/plans/w/wait?timeoutSeconds=1")).json();
    expect(failed.stuck).toBe(true);
    expect(failed.stuckReasons).toEqual([{ goalId: "a", taskId: "boof-a", status: "failed" }]);
    const taskWait = await (
      await call("/projects/shop/tasks/boof-a/wait?timeoutSeconds=30")
    ).json();
    expect(taskWait).toMatchObject({ changed: false, timedOut: false, terminal: true });

    // A stopped task is just as stuck and just as terminal; retry and inject by a client.
    await store.transition("boof-a", "pending");
    await store.transition("boof-a", "running");
    const inj = await call(
      "/projects/shop/tasks/boof-a/inject",
      send("POST", { prompt: "Mind the edge cases." }),
    );
    expect(inj.status).toBe(200);
    await store.transition("boof-a", "stopped");
    const stopped = await (await call("/projects/shop/plans/w/wait?timeoutSeconds=1")).json();
    expect(stopped.stuck).toBe(true);
    expect(stopped.stuckReasons).toEqual([{ goalId: "a", taskId: "boof-a", status: "stopped" }]);
    const stoppedWait = await (
      await call("/projects/shop/tasks/boof-a/wait?timeoutSeconds=30")
    ).json();
    expect(stoppedWait).toMatchObject({ changed: false, timedOut: false, terminal: true });
    expect(stoppedWait.task.frontmatter.status).toBe("stopped");
    // The injected prompt is on the task view, with its author, after the run ended.
    expect(stoppedWait.task.body.injected).toContain("Mind the edge cases.");
    expect(stoppedWait.task.body.injected).toContain("— harness");
    const retried = await call("/projects/shop/tasks/boof-a/retry", send("POST"));
    expect(retried.status).toBe(200);
    expect((await retried.json()).frontmatter.status).toBe("pending");
  });
});
