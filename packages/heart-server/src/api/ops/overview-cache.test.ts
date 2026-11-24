import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStore, LOCAL_PRINCIPAL } from "@boof/heart";
import { MockTool, ToolRegistry } from "@boof/runner";
import type { OpContext } from "../define-op.js";
import { getOp } from "../registry.js";
import { finishedBranchOf } from "./admin.js";
import { TaskService } from "../services/service.js";

let root: string;
let repo: string;
let service: TaskService;

const overview = async () =>
  (await getOp("runner.overview")!.execute(
    {
      root,
      principal: LOCAL_PRINCIPAL,
      services: service,
      authStore: new AuthStore(root),
      now: () => new Date().toISOString(),
    } as OpContext,
    {},
  )) as {
    projects: { id: string; paused: boolean; counts: Record<string, number> }[];
  };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-overview-"));
  repo = await mkdtemp(join(tmpdir(), "boof-overview-wd-"));
  execFileSync("git", ["init", "-q", repo]);
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  await service.createProject({ workingDirectory: repo, id: "alpha" });
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe("runner.overview cache", () => {
  it("answers repeat calls from one computation and recomputes after the TTL", async () => {
    const spy = vi.spyOn(service, "budgetStatus");
    await overview();
    await overview();
    await Promise.all([overview(), overview()]);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 5_000 });
    await overview();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("shows a task created or a project paused by this process at once", async () => {
    const before = await overview();
    expect(before.projects[0]!.counts.pending ?? 0).toBe(0);
    await service.forProject("alpha").create({ title: "t", status: "pending" });
    const after = await overview();
    expect(after.projects[0]!.counts.pending).toBe(1);
    expect(after.projects[0]!.paused).toBe(false);
    await service.pauseProject("alpha");
    expect((await overview()).projects[0]!.paused).toBe(true);
  });

  it("does not keep a failed computation", async () => {
    const spy = vi.spyOn(service, "budgetStatus").mockRejectedValueOnce(new Error("boom"));
    await expect(overview()).rejects.toThrow();
    await expect(overview()).resolves.toBeDefined();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("finishedBranchOf", () => {
  const goal = (id: string, order: number, status: string, branches: string[]) => ({
    id,
    order,
    status,
    tasks: branches.map((branch) => ({ branch })),
  });
  const plan = (...goals: ReturnType<typeof goal>[]) => ({ goals }) as never;

  it("is the last task branch of the last goal, goals by order then id", () => {
    expect(
      finishedBranchOf(
        plan(
          goal("b", 2, "done", ["boof-runner/b1", "boof-runner/b2"]),
          goal("a", 1, "done", ["boof-runner/a1"]),
        ),
      ),
    ).toBe("boof-runner/b2");
  });

  it("skips a last goal that ran no task, and is null when a goal is open or none ran", () => {
    expect(
      finishedBranchOf(plan(goal("a", 1, "done", ["boof-runner/a1"]), goal("b", 2, "done", []))),
    ).toBe("boof-runner/a1");
    expect(
      finishedBranchOf(plan(goal("a", 1, "done", ["x"]), goal("b", 2, "develop", []))),
    ).toBeNull();
    expect(finishedBranchOf(plan(goal("a", 1, "done", [])))).toBeNull();
    expect(finishedBranchOf(plan())).toBeNull();
  });
});
