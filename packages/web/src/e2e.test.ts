import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, SettingsStore } from "@boof-runner/shared";
import { RunnerEngine, execCommand, mockState, resetMock } from "@boof-runner/runner";
import { createApp } from "./app.js";
import { TaskService } from "./service.js";

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

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "boof-runner-e2e-data-"));
  workDir = await mkdtemp(join(tmpdir(), "boof-runner-e2e-work-"));
  const g = (args: string[]) => execCommand("git", args, { cwd: workDir, timeoutMs: 15000 });
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "t@e.com"]);
  await g(["config", "user.name", "T"]);
  await writeFile(join(workDir, "README.md"), "# work\n");
  await g(["add", "."]);
  await g(["commit", "-m", "init"]);

  service = new TaskService(dataRoot);
  await service.tasks.ensureDirs();
  // All roles use the mock tool; runner enabled; workingDirectory is the git repo.
  const s = defaultSettings(workDir);
  s.runner.enabled = true;
  s.roles = {
    planner: { tool: "mock", model: "mock-default" },
    developer: { tool: "mock", model: "mock-default" },
    reviewer: { tool: "mock", model: "mock-default" },
  };
  await new SettingsStore(dataRoot).save(s);

  app = createApp({ service });
  engine = new RunnerEngine({ root: dataRoot, pollIntervalMs: 10 });
  resetMock();
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
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
    expect(next?.frontmatter.id).toBe("ship-feature");

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
