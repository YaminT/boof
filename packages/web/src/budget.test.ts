import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, recordSpend, SettingsStore } from "@boof-runner/shared";
import { execCommand, MockTool, ToolRegistry } from "@boof-runner/runner";
import { TaskService } from "@boof-runner/api";
import { createApp } from "./app.js";

let root: string;
let repo: string;
let app: ReturnType<typeof createApp>;

const V1 = "/api/v1";
const call = (path: string, init: RequestInit = {}) => app.request("http://localhost" + path, init);
const put = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-budget-api-"));
  repo = await realpath(await mkdtemp(join(tmpdir(), "boof-budget-repo-")));
  await execCommand("git", ["init", "-q"], { cwd: repo });
  await new SettingsStore(root).save(defaultSettings());
  const service = new TaskService(root, new ToolRegistry([new MockTool()]));
  await service.projects.create({ workingDirectory: repo, id: "demo" });
  app = createApp({ service, peerAddress: () => "127.0.0.1" });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe("budget API", () => {
  it("reports no limits and no spend by default", async () => {
    const res = await call(`${V1}/usage/budget`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.exceeded).toEqual([]);
    expect(b.limits.onExceed).toBe("pause");
    expect(b.scopes[0]).toMatchObject({ scope: "global", spentUsd: 0, limitUsd: null });
    expect(b.projects).toEqual([{ id: "demo", perTaskUsd: null, onExceed: "pause" }]);
    const runner = await (await call(`${V1}/runner`)).json();
    expect(runner.budgetExceeded).toEqual([]);
  });

  it("accepts budget in settings and as a project override, and shows spend and exceeded scopes", async () => {
    const saved = await call(
      `${V1}/settings`,
      put({ budget: { perDayUsd: 5, perToolDayUsd: { mock: 1 }, timezone: "UTC" } }),
    );
    expect(saved.status).toBe(200);
    expect((await saved.json()).budget).toMatchObject({ perDayUsd: 5, onExceed: "pause" });
    const proj = await call(`${V1}/projects/demo`, put({ budget: { perProjectDayUsd: 2 } }));
    expect(proj.status).toBe(200);
    expect((await proj.json()).budget).toEqual({ perProjectDayUsd: 2 });

    await recordSpend({
      dataRoot: root,
      projectId: "demo",
      tool: "mock",
      usage: { costUsd: 2.5, known: true },
      timezone: "UTC",
    });
    const b = await (await call(`${V1}/usage/budget`)).json();
    const by = Object.fromEntries(b.scopes.map((s: { scope: string }) => [s.scope, s]));
    expect(by.global).toMatchObject({ spentUsd: 2.5, limitUsd: 5, remainingUsd: 2.5 });
    expect(by["tool:mock"]).toMatchObject({ exceeded: true, remainingUsd: 0 });
    expect(by["project:demo"]).toMatchObject({ exceeded: true, limitUsd: 2 });
    expect(b.resetsAt).toMatch(/T00:00:00\.000Z$/);

    const status = await (await call(`${V1}/runner/status`)).json();
    expect(status.budgetExceeded.map((s: { scope: string }) => s.scope)).toEqual([
      "tool:mock",
      "project:demo",
    ]);
  });

  it("rejects invalid budgets", async () => {
    expect((await call(`${V1}/settings`, put({ budget: { timezone: "Mars/Base" } }))).status).toBe(
      400,
    );
    expect((await call(`${V1}/settings`, put({ budget: { perTaskUsd: -1 } }))).status).toBe(400);
    expect((await call(`${V1}/projects/demo`, put({ budget: { perDayUsd: 1 } }))).status).toBe(400);
  });
});
