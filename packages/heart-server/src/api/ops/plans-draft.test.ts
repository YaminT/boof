import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStore, LOCAL_PRINCIPAL, ProjectStore, type Principal } from "@boof/heart";
import { MockTool, ToolRegistry, type Tool } from "@boof/runner";
import type { OpContext } from "../define-op.js";
import { getOp } from "../registry.js";
import { TaskService } from "../services/service.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10 });
});

const missing = (): Tool =>
  ({
    id: "gone",
    displayName: "Gone Tool",
    defaultModels: ["m"],
    installed: async () => ({ installed: false, message: "not found on PATH" }),
    detect: async () => {
      throw new Error("no probe");
    },
    listModels: async () => [],
    run: async () => {
      throw new Error("not used");
    },
  }) as Tool;

async function setup(principal: Principal = LOCAL_PRINCIPAL) {
  const root = await mkdtemp(join(tmpdir(), "boof-draftops-"));
  const work = await mkdtemp(join(tmpdir(), "boof-draftops-work-"));
  dirs.push(root, work);
  await new ProjectStore(root).create({ workingDirectory: work, id: "proj" });
  const ctx: OpContext = {
    root,
    principal: LOCAL_PRINCIPAL,
    services: new TaskService(root, new ToolRegistry([new MockTool(), missing()])),
    authStore: new AuthStore(root),
    now: () => "2026-01-01T00:00:00.000Z",
  };
  const call = (op: string, input: object) => getOp(op)!.execute(ctx, input) as Promise<any>;
  await call("plans.create", {
    projectId: "proj",
    id: "pl",
    title: "Plan",
    description: "Build X",
  });
  return {
    ctx: { ...ctx, principal },
    call: (op: string, input: object) =>
      getOp(op)!.execute({ ...ctx, principal }, input) as Promise<any>,
    work,
  };
}

const draft = { projectId: "proj", planId: "pl", tool: "mock", model: "mock-default" };

describe("plans.draftGoals", () => {
  it("is REST-only and needs tasks:write", () => {
    const op = getOp("plans.draftGoals")!;
    expect(op.scopes).toEqual(["tasks:write"]);
    expect(op.mcp.expose).toBe(false);
    expect(op.rest).toMatchObject({
      method: "POST",
      path: "/projects/{projectId}/plans/{planId}/draft",
    });
  });

  it("queues a plan-draft task with the planner override and shows it on plans.get", async () => {
    const { call } = await setup();
    const out = await call("plans.draftGoals", { ...draft, note: "keep it small" });
    expect(out.task.status).toBe("pending");
    const task = await call("tasks.get", { projectId: "proj", taskId: out.task.id });
    expect(task.frontmatter).toMatchObject({
      draftFor: { planId: "pl", planVersion: 1 },
      promptSource: "manual",
      tools: { planner: { tool: "mock", model: "mock-default" } },
    });
    expect(task.body.prompt).toContain("Build X");
    expect(task.body.prompt).toContain("keep it small");
    const plan = await call("plans.get", { projectId: "proj", planId: "pl" });
    expect(plan.draftTask).toEqual({ id: out.task.id, status: "pending" });
  });

  it("refuses a second draft while one is pending (409 draft_in_progress)", async () => {
    const { call } = await setup();
    await call("plans.draftGoals", draft);
    await expect(call("plans.draftGoals", draft)).rejects.toMatchObject({
      status: 409,
      code: "draft_in_progress",
    });
  });

  it("refuses a tool that is not installed or unknown (400 tool_not_installed)", async () => {
    const { call } = await setup();
    await expect(
      call("plans.draftGoals", { ...draft, tool: "gone", model: "m" }),
    ).rejects.toMatchObject({
      status: 400,
      code: "tool_not_installed",
    });
    await expect(
      call("plans.draftGoals", { ...draft, tool: "nope", model: "m" }),
    ).rejects.toMatchObject({
      code: "tool_not_installed",
    });
  });

  it("refuses a plan that is not a draft and a missing model", async () => {
    const { call } = await setup();
    await expect(call("plans.draftGoals", { ...draft, model: "" })).rejects.toMatchObject({
      status: 400,
      code: "invalid_input",
    });
    await call("plans.update", { projectId: "proj", planId: "pl", status: "archived" });
    await expect(call("plans.draftGoals", draft)).rejects.toMatchObject({
      status: 409,
      code: "plan_not_draft",
    });
  });

  it("refuses an unknown plan", async () => {
    const { call } = await setup();
    await expect(call("plans.draftGoals", { ...draft, planId: "nope" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("refuses a review-trust client (403 forbidden_trust)", async () => {
    const reviewer = {
      kind: "client",
      id: "bot",
      trust: "review",
      scopes: new Set(["admin"]),
      projects: "*",
      clientKind: "harness",
    } as unknown as Principal;
    const { call } = await setup(reviewer);
    await expect(call("plans.draftGoals", draft)).rejects.toMatchObject({
      status: 403,
      code: "forbidden_trust",
    });
  });
});

describe("projects.detectStack", () => {
  it("is REST-only with projects:read and reads the project directory", async () => {
    const op = getOp("projects.detectStack")!;
    expect(op.scopes).toEqual(["projects:read"]);
    expect(op.mcp.expose).toBe(false);
    const { call, work } = await setup();
    await writeFile(join(work, "Cargo.toml"), "[package]\n");
    expect(await call("projects.detectStack", { projectId: "proj" })).toEqual({
      detected: ["Cargo.toml"],
      stack: "Rust (cargo)",
      testCommand: "cargo test",
    });
  });
});
