import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStore, LOCAL_PRINCIPAL, ProjectStore, TaskStore, type Principal } from "@boof/heart";
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

const agentSdk = (): Tool =>
  ({
    id: "claude-agent",
    displayName: "Claude Agent",
    defaultModels: ["m"],
    needsAgentAuth: true,
    installed: async () => ({ installed: true, message: "ok" }),
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
    services: new TaskService(root, new ToolRegistry([new MockTool(), missing(), agentSdk()])),
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
    root,
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

  it("stores the wizard's project answers per project and puts them in later drafts", async () => {
    const { call } = await setup();
    const saved = await call("projects.update", {
      projectId: "proj",
      planDefaults: {
        stack: "TypeScript, Node.js",
        testCommand: "npm test",
        doRules: "Keep functions small\nWrite a test first",
        dontRules: "Never edit generated files",
      },
    });
    expect(saved.planDefaults).toMatchObject({ testCommand: "npm test" });
    // Persisted with the project, so a later session (or another browser) finds them.
    expect((await call("projects.get", { projectId: "proj" })).planDefaults).toMatchObject({
      stack: "TypeScript, Node.js",
    });
    const out = await call("plans.draftGoals", draft);
    const task = await call("tasks.get", { projectId: "proj", taskId: out.task.id });
    const prompt = task.body.prompt as string;
    expect(prompt).toContain("Stack: TypeScript, Node.js");
    expect(prompt).toContain("Test command: npm test");
    expect(prompt).toContain("- Write a test first");
    expect(prompt).toContain("- Never edit generated files");
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

  it("refuses claude-agent with the gateway reason before creating a task (400 agent_not_ready)", async () => {
    const { call } = await setup();
    await expect(
      call("plans.draftGoals", { ...draft, tool: "claude-agent", model: "default" }),
    ).rejects.toMatchObject({
      status: 400,
      code: "agent_not_ready",
      message: expect.stringMatching(/no better-ccflare gateway is configured/),
    });
    const tasks = await call("tasks.list", { projectId: "proj" });
    expect(JSON.stringify(tasks)).not.toContain("plan-draft");
  });

  it("reports a tool that cannot start per project on harnesses.status", async () => {
    const { call } = await setup();
    const plain = await call("harnesses.status", {});
    expect(plain.tools["claude-agent"].startBlock).toBeUndefined();
    const out = await call("harnesses.status", { forProject: "proj" });
    expect(out.tools["claude-agent"].startBlock).toMatch(/no better-ccflare gateway/);
  });

  it("drops a failed draft task when the user drafts again", async () => {
    const { call, root } = await setup();
    const first = await call("plans.draftGoals", draft);
    const store = new TaskStore(new ProjectStore(root).dir("proj"));
    await store.transition(first.task.id, "failed");
    const second = await call("plans.draftGoals", draft);
    // The failed one is gone: one draft task of the plan remains, and it is the new, pending one.
    const drafts = (await store.list()).filter((t) => t.frontmatter.draftFor?.planId === "pl");
    expect(drafts.map((t) => t.frontmatter.status)).toEqual(["pending"]);
    expect(second.task.status).toBe("pending");
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

  it("refuses a tasks:write key without plans:write", async () => {
    const writer = {
      kind: "client",
      id: "bot",
      trust: "full",
      scopes: new Set(["tasks:write", "plans:read", "projects:read"]),
      projects: "*",
      clientKind: "harness",
    } as unknown as Principal;
    const { call, work } = await setup(writer);
    await expect(call("plans.draftGoals", draft)).rejects.toMatchObject({
      status: 403,
      code: "forbidden_scope",
    });
    void work;
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
