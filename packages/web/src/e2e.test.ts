import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, SettingsStore } from "@boof-runner/shared";
import { RunnerEngine, execCommand, mockState, resetMock } from "@boof-runner/runner";
import { createApp } from "./app.js";
import { TaskService } from "@boof-runner/api";

let dataRoot: string;
let workDir: string;
let service: TaskService;
let app: ReturnType<typeof createApp>;
let engine: RunnerEngine;

const req = (path: string, init?: RequestInit) => app.request("http://localhost" + path, init);
const post = (path: string, body: unknown) =>
  req(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const put = (path: string, body: unknown) =>
  req(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const extraDirs: string[] = [];

/** A fresh git repository with one commit; removed after the test. */
async function initRepo(label: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `boof-runner-e2e-${label}-`)));
  extraDirs.push(dir);
  const g = (args: string[]) => execCommand("git", args, { cwd: dir, timeoutMs: 15000 });
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "t@e.com"]);
  await g(["config", "user.name", "T"]);
  await writeFile(join(dir, "README.md"), `# ${label}\n`);
  await g(["add", "."]);
  await g(["commit", "-m", "init"]);
  return dir;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "boof-runner-e2e-data-"));
  workDir = await initRepo("work");

  service = new TaskService(dataRoot);
  // All roles use the mock tool; runner enabled; project `default` is the git repo.
  const s = defaultSettings();
  s.runner.enabled = true;
  s.defaultProject = "default";
  s.roles = {
    planner: { tool: "mock", model: "mock-default" },
    developer: { tool: "mock", model: "mock-default" },
    reviewer: { tool: "mock", model: "mock-default" },
  };
  await new SettingsStore(dataRoot).save(s);
  await service.projects.create({ workingDirectory: workDir, id: "default" });

  app = createApp({ service, peerAddress: () => "127.0.0.1" });
  engine = new RunnerEngine({ root: dataRoot, pollIntervalMs: 10 });
  resetMock();
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  for (const dir of extraDirs.splice(0))
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  resetMock();
});

describe("E2E: draft → enqueue → reorder → run → answer → done (mock tool)", () => {
  it("walks a task through the full lifecycle via the API + runner", async () => {
    // 1. Create a draft via the API.
    const draft = await (
      await post("/api/tasks", { title: "Ship Feature", prompt: "Build it." })
    ).json();
    expect(draft.frontmatter.status).toBe("draft");

    // 2. Create a second task to exercise reordering.
    await post("/api/tasks", { title: "Other Task", status: "pending" });

    // 3. Save & enqueue the draft (draft → pending).
    const enqueued = await (
      await put(`/api/tasks/${draft.frontmatter.id}`, { status: "pending", priority: 10 })
    ).json();
    expect(enqueued.frontmatter.status).toBe("pending");

    // 4. Reorder so "ship-feature" runs first (highest priority).
    await post("/api/tasks/reorder", { order: ["ship-feature", "other-task"] });
    const next = await engine.selectNext();
    expect(next?.task.frontmatter.id).toBe("ship-feature");

    // 5. Planner asks a question → task parks in actions/.
    mockState.plannerQuestions = ["Which framework?"];
    const t1 = await engine.tick();
    expect(t1.kind).toBe("ran");
    const parkedList = await (await req("/api/tasks")).json();
    const parked = parkedList.tasks.find((x: any) => x.frontmatter.id === "ship-feature");
    expect(parked.frontmatter.status).toBe("action");
    expect(parked.frontmatter.questions).toBe("pending");

    // 6. Answer via the Actions API → resumes to pending.
    const answered = await (
      await post("/api/tasks/ship-feature/answers", { answers: "Use Hono." })
    ).json();
    expect(answered.frontmatter.status).toBe("pending");
    expect(answered.frontmatter.questions).toBe("answered");

    // 7. Run remaining queue to completion.
    await engine.runUntilIdle();
    const finalList = await (await req("/api/tasks")).json();
    const shipped = finalList.tasks.find((x: any) => x.frontmatter.id === "ship-feature");
    expect(shipped.frontmatter.status).toBe("done");
    expect(shipped.body.reports.reviewer).toContain("Review");

    // The other task also completed.
    const other = finalList.tasks.find((x: any) => x.frontmatter.id === "other-task");
    expect(other.frontmatter.status).toBe("done");

    // 8. Global token usage was recorded.
    const usage = await (await req("/api/usage")).json();
    expect(usage.known).toBe(true);
  });
});

describe("E2E: two projects served by one runner (mock tool)", () => {
  it("registers two repos over the API, queues in each, drains both, and aggregates actions and usage", async () => {
    const other = await initRepo("other");
    const created = await (
      await post("/api/projects", { workingDirectory: other, id: "other" })
    ).json();
    expect(created).toMatchObject({ id: "other", workingDirectory: other });
    expect((await (await req("/api/projects")).json()).projects.map((p: any) => p.id)).toEqual([
      "default",
      "other",
    ]);

    const roles = {
      planner: { tool: "mock", model: "mock-default" },
      developer: { tool: "mock", model: "mock-default" },
      reviewer: { tool: "mock", model: "mock-default" },
    };
    await put("/api/settings", { roles });
    await post("/api/projects/default/tasks", { title: "Alpha", status: "pending", priority: 20 });
    await post("/api/projects/other/tasks", { title: "Beta", status: "pending", priority: 80 });

    // The runner serves the higher-priority task first, whichever project it is in.
    expect((await engine.selectNext())?.project.id).toBe("other");
    mockState.plannerQuestions = ["Which one?"];
    const first = await engine.tick();
    expect(first.kind === "ran" && first.projectId).toBe("other");

    // Beta is parked: it shows up in the cross-project actions aggregate with its project id.
    const actions = (await (await req("/api/actions")).json()).actions;
    expect(actions.map((a: any) => [a.projectId, a.frontmatter.id])).toEqual([["other", "beta"]]);

    await engine.runUntilIdle();
    const alpha = await (await req("/api/projects/default/tasks/alpha")).json();
    expect(alpha.frontmatter.status).toBe("done");
    expect(alpha.projectId).toBe("default");
    // Tasks are not shared between projects.
    expect((await req("/api/projects/other/tasks/alpha")).status).toBe(404);

    await post("/api/projects/other/tasks/beta/answers", { answers: "This one." });
    await engine.runUntilIdle();
    const beta = await (await req("/api/projects/other/tasks/beta")).json();
    expect(beta.frontmatter.status).toBe("done");

    // Usage is per project, and the global number is the sum.
    const a = await (await req("/api/projects/default/usage")).json();
    const b = await (await req("/api/projects/other/usage")).json();
    const total = await (await req("/api/usage")).json();
    expect(a.known && b.known).toBe(true);
    expect(total.inputTokens).toBe(a.inputTokens + b.inputTokens);
    expect(total.costUsd).toBeCloseTo(a.costUsd + b.costUsd);
  });
});
