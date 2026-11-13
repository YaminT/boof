import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, LOCAL_PRINCIPAL } from "@boof/heart";
import { ProjectStore } from "@boof/heart";
import { MockTool, ToolRegistry, type Tool } from "@boof/runner";
import type { OpContext } from "../define-op.js";
import { getOp } from "../registry.js";
import { TaskService } from "../services/service.js";

let root: string;
let ctx: OpContext;
let checks: number;

const fake = (installed: boolean): Tool =>
  ({
    id: "fake",
    displayName: "Fake Tool",
    defaultModels: [],
    installed: async () => {
      checks += 1;
      return installed
        ? {
            installed: true,
            version: "1.0",
            path: "/x/fake",
            foundOffPath: "/x/fake",
            message: "m",
          }
        : { installed: false, message: "not found" };
    },
    detect: async () => {
      throw new Error("a health probe must not run");
    },
    listModels: async () => [],
    run: async () => {
      throw new Error("not used");
    },
  }) as Tool;

const setup = async (tool: Tool, tools: Tool[] = [tool]) => {
  root = await mkdtemp(join(tmpdir(), "boof-harnesses-"));
  checks = 0;
  ctx = {
    root,
    principal: LOCAL_PRINCIPAL,
    services: new TaskService(root, new ToolRegistry(tools)),
    authStore: new AuthStore(root),
    now: () => "2026-01-01T00:00:00.000Z",
  };
};
beforeEach(() => {
  checks = 0;
});
afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe("harnesses.status operation", () => {
  it("is REST-only, needs settings:read and has no project scope", async () => {
    await setup(fake(true));
    const op = getOp("harnesses.status");
    expect(op?.scopes).toEqual(["settings:read"]);
    expect(op?.mcp.expose).toBe(false);
    expect(op?.rest).toMatchObject({ method: "GET", path: "/harnesses" });
  });

  it("reports installed tools, anyInstalled and the off-PATH path, without a health probe", async () => {
    await setup(fake(true));
    const out = (await getOp("harnesses.status")!.execute(ctx, {})) as {
      tools: Record<string, { installed: boolean; foundOffPath?: string; displayName: string }>;
      anyInstalled: boolean;
      checkedAt: string;
    };
    expect(out.anyInstalled).toBe(true);
    expect(out.tools.fake).toMatchObject({
      installed: true,
      displayName: "Fake Tool",
      foundOffPath: "/x/fake",
    });
    expect(Number.isNaN(Date.parse(out.checkedAt))).toBe(false);
  });

  it("says anyInstalled false when nothing is installed, caches, and refresh is rate-limited", async () => {
    await setup(fake(false));
    const run = (refresh?: boolean) =>
      getOp("harnesses.status")!.execute(ctx, refresh === undefined ? {} : { refresh }) as Promise<{
        anyInstalled: boolean;
      }>;
    expect((await run()).anyInstalled).toBe(false);
    await run();
    expect(checks).toBe(1);
    await run(true);
    expect(checks).toBe(1);
  });

  it("hides the mock tool: it is not an installed agent unless a dev flag is set", async () => {
    const saved = process.env.BOOF_SHOW_MOCK_TOOL;
    delete process.env.BOOF_SHOW_MOCK_TOOL;
    try {
      await setup(fake(false), [new MockTool(), fake(false)]);
      const out = (await getOp("harnesses.status")!.execute(ctx, {})) as {
        tools: Record<string, { installed: boolean }>;
        anyInstalled: boolean;
      };
      expect(out.tools.mock).toBeUndefined();
      expect(out.tools.fake.installed).toBe(false);
      expect(out.anyInstalled).toBe(false);
    } finally {
      if (saved !== undefined) process.env.BOOF_SHOW_MOCK_TOOL = saved;
    }
  });

  it("lists the mock tool when BOOF_SHOW_MOCK_TOOL is set", async () => {
    const saved = process.env.BOOF_SHOW_MOCK_TOOL;
    process.env.BOOF_SHOW_MOCK_TOOL = "1";
    try {
      await setup(fake(false), [new MockTool(), fake(false)]);
      const out = (await getOp("harnesses.status")!.execute(ctx, {})) as {
        tools: Record<string, { installed: boolean }>;
        anyInstalled: boolean;
      };
      expect(out.tools.mock.installed).toBe(true);
      expect(out.anyInstalled).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.BOOF_SHOW_MOCK_TOOL;
      else process.env.BOOF_SHOW_MOCK_TOOL = saved;
    }
  });
});

const agentSdk = (): Tool =>
  ({ ...fake(true), id: "claude-agent", displayName: "Claude Agent" }) as Tool;

const status = () => getOp("harnesses.status")!.execute(ctx, {}) as Promise<any>;

describe("agent readiness", () => {
  it("an installed tool is ready, with a reason", async () => {
    await setup(fake(true));
    const out = await status();
    expect(out.anyReady).toBe(true);
    expect(out.tools.fake).toMatchObject({ installed: true, ready: true });
    expect(out.tools.fake.readyReason).toMatch(/Installed/);
  });

  it("a tool that is not installed is not ready and says how to fix it", async () => {
    await setup(fake(false));
    const out = await status();
    expect(out.anyReady).toBe(false);
    expect(out.tools.fake).toMatchObject({ ready: false, fixPage: "agents" });
    expect(out.tools.fake.fixHint).toMatch(/Install/);
    expect(out.checks.find((c: any) => c.id === "agents")).toMatchObject({
      status: "fail",
      fixPage: "agents",
    });
  });

  it("claude-agent needs the gateway or an API key; without either it is not ready", async () => {
    await setup(agentSdk());
    const out = await status();
    expect(out.anyReady).toBe(false);
    expect(out.tools["claude-agent"].ready).toBe(false);
    expect(out.tools["claude-agent"].fixHint).toMatch(/better-ccflare gateway/);
    expect(out.tools["claude-agent"].fixPage).toBe("gateway");
    expect(out.gateway.status).toBe("absent");
    expect(out.checks.find((c: any) => c.id === "gateway")).toMatchObject({
      status: "fail",
      message: "Not configured.",
      fixPage: "gateway",
    });
  });

  it("a configured gateway makes claude-agent ready without sending a prompt", async () => {
    await setup(agentSdk());
    await ctx.services.updateSettings(
      { owlish: { url: "http://127.0.0.1:9" } } as never,
      ctx.principal,
    );
    const out = await status();
    expect(out.tools["claude-agent"].ready).toBe(true);
    expect(out.anyReady).toBe(true);
    // The gateway is not running here: the row says so, and is not the agents check.
    expect(out.gateway.status).toBe("unreachable");
    expect(out.checks.find((c: any) => c.id === "gateway").status).toBe("fail");
  });

  it("reports the setup checks: git, data folder, projects folder and sandbox", async () => {
    await setup(fake(true));
    const out = await status();
    expect(out.checks.map((c: any) => c.id)).toEqual([
      "agents",
      "gateway",
      "projectsRoot",
      "git",
      "dataRoot",
      "sandbox",
    ]);
    expect(out.checks.find((c: any) => c.id === "dataRoot").status).toBe("pass");
    expect(out.checks.find((c: any) => c.id === "agents").status).toBe("pass");
    // No secret in the answer.
    expect(JSON.stringify(out)).not.toMatch(/apiKey|secret|token/i);
  });
});

describe("starting work with no agent ready", () => {
  it("refuses the runner switch with no_agent_ready, and allows pausing", async () => {
    await setup(fake(false));
    await expect(getOp("runner.setEnabled")!.execute(ctx, { enabled: true })).rejects.toMatchObject(
      {
        status: 409,
        code: "no_agent_ready",
      },
    );
    await expect(
      getOp("runner.setEnabled")!.execute(ctx, { enabled: false }),
    ).resolves.toBeTruthy();
  });

  it("refuses queueing, retrying and creating a pending task", async () => {
    await setup(fake(false));
    const work = await mkdtemp(join(tmpdir(), "boof-harnesses-work-"));
    try {
      await new ProjectStore(root).create({ workingDirectory: work, id: "proj" });
      const call = (op: string, input: object) => getOp(op)!.execute(ctx, input);
      const task = (await call("tasks.create", { projectId: "proj", title: "T" })) as any;
      const id = task.frontmatter?.id ?? task.id;
      const refused = { status: 409, code: "no_agent_ready" };
      await expect(call("tasks.queue", { projectId: "proj", taskId: id })).rejects.toMatchObject(
        refused,
      );
      await expect(call("tasks.retry", { projectId: "proj", taskId: id })).rejects.toMatchObject(
        refused,
      );
      await expect(
        call("tasks.create", { projectId: "proj", title: "U", status: "pending" }),
      ).rejects.toMatchObject(refused);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("allows starting when an agent is ready", async () => {
    await setup(fake(true));
    await expect(getOp("runner.setEnabled")!.execute(ctx, { enabled: true })).resolves.toBeTruthy();
  });
});
