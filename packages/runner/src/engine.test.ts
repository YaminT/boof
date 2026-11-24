import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  defaultSettings,
  effectiveSettings,
  newTask,
  SettingsStore,
  ExternalRunStore,
  TaskStore,
  taskControlDir,
  taskStopRequestPath,
  type Project,
  type TaskFrontmatter,
  readEvents,
  resetSandboxStatus,
} from "@boof/heart";
import { RunnerEngine } from "./engine.js";
import { Pipeline } from "./pipeline.js";
import { MockTool, mockState } from "./tools/mock.js";
import { ToolRegistry, defaultTools } from "./tools/registry.js";
import type { RunOptions } from "./tools/types.js";
import { DESKTOP_CLAUDE_AGENT_REASON } from "./index.js";
import { ClaudeAgentTool } from "./tools/claude-agent.js";
import { AgentAuthResolver } from "./agent-auth.js";
import { ProjectKeyStore } from "@boof/owlish";
import {
  useEngineRig,
  exists,
  wtPath,
  gitOut,
  writeIn,
  commitIn,
  fm,
} from "./engine-test-support.js";

let dataRoot: string;
let workDir: string;
let engine: RunnerEngine;
/** The project under test: `workDir` registered as project `default`. */
let project: Project;
let projectDir: string;
let store: TaskStore;

useEngineRig((rig) => {
  ({ dataRoot, workDir, engine, project, projectDir, store } = rig);
});

describe("RunnerEngine selection unit tests (stubbed auth, mock tools)", () => {
  it("fails a refused Agent SDK task before its worktree, records one event, then serves a sibling", async () => {
    const reason =
      'claude-agent cannot start: account "Personal OAuth" is anthropic. subscription (OAuth) accounts stay on the claude-code CLI.';
    const agent = new MockTool();
    const wrapped = {
      id: "claude-agent",
      displayName: "Claude Agent",
      defaultModels: ["default"],
      needsAgentAuth: true,
      installed: () => agent.installed(),
      detect: () => agent.detect(),
      listModels: () => agent.listModels(),
      run: (opts: RunOptions) => agent.run(opts),
    };
    engine = new RunnerEngine({
      root: dataRoot,
      pollIntervalMs: 10,
      registry: new ToolRegistry([new MockTool(), wrapped]),
      agentAuth: { decide: async () => ({ ok: false, reason }) } as never,
    });
    await store.create(
      newTask(
        fm({ tools: { ...fm().tools, developer: { tool: "claude-agent", model: "default" } } }),
        "Agent work.",
      ),
    );
    await store.create(newTask(fm({ id: "sibling", priority: 40 }), "Sibling work."));
    const result = await engine.tick();
    expect(result.kind).toBe("ran");
    expect((await store.get("t1"))?.body.log).toContain("### Not started");
    expect((await store.get("t1"))?.body.log).toContain("Personal OAuth");
    expect((await store.get("t1"))?.body.log).toContain(
      "subscription (OAuth) accounts stay on the claude-code CLI",
    );
    expect((await store.get("t1"))?.frontmatter.status).toBe("failed");
    expect(await exists(wtPath("t1"))).toBe(false);
    expect((await store.get("sibling"))?.frontmatter.status).toBe("done");
    const events = (await readEvents(dataRoot, null)).filter(
      (e) => e.event.type === "runner.agent_auth_refused",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({ projectId: project.id, taskId: "t1", reason });
    await engine.selectNext();
    expect(
      (await readEvents(dataRoot, null)).filter(
        (e) => e.event.type === "runner.agent_auth_refused",
      ),
    ).toHaveLength(1);
  });

  it.skipIf(process.platform !== "linux")(
    "fails an enforce task before any agent starts when the sandbox helper is missing, and does not retry it",
    async () => {
      const prevHelper = process.env.BOOF_SANDBOX_HELPER;
      const prevAbi = process.env.BOOF_SANDBOX_FAKE_ABI;
      process.env.BOOF_SANDBOX_HELPER = "/no/such/boof-sandbox";
      delete process.env.BOOF_SANDBOX_FAKE_ABI;
      try {
        const settings = new SettingsStore(dataRoot);
        const current = await settings.load();
        await settings.save({
          ...current,
          runner: {
            ...current.runner,
            sandbox: { ...current.runner.sandbox, mode: "enforce" },
          },
        });
        await store.create(newTask(fm(), "Sandboxed work."));
        const result = await engine.tick();
        expect(result.kind).toBe("idle");
        const task = await store.get("t1");
        expect(task?.frontmatter.status).toBe("failed");
        expect(task?.body.log).toContain("### Not started");
        expect(task?.body.log).toContain("sandbox_unavailable: boof-sandbox helper is missing");
        expect(mockState.calls).toEqual([]);
        expect(await exists(wtPath("t1"))).toBe(false);
        expect(
          (await readEvents(dataRoot, null)).filter(
            (e) => e.event.type === "runner.agent_auth_refused",
          ),
        ).toHaveLength(0);
        await engine.tick();
        expect((await store.get("t1"))?.frontmatter.status).toBe("failed");
        expect(mockState.calls).toEqual([]);
      } finally {
        if (prevHelper === undefined) delete process.env.BOOF_SANDBOX_HELPER;
        else process.env.BOOF_SANDBOX_HELPER = prevHelper;
        if (prevAbi === undefined) delete process.env.BOOF_SANDBOX_FAKE_ABI;
        else process.env.BOOF_SANDBOX_FAKE_ABI = prevAbi;
        resetSandboxStatus();
      }
    },
  );

  it("an n8n check task is not touched by agent auth or an unavailable tool; a normal task still is", async () => {
    const decide = vi.fn(async () => ({ ok: false as const, reason: "auth refused" }));
    const agent = new MockTool();
    const wrapped = {
      id: "claude-agent",
      displayName: "Claude Agent",
      defaultModels: ["default"],
      needsAgentAuth: true,
      unavailableReason: "agent tool unavailable",
      installed: () => agent.installed(),
      detect: () => agent.detect(),
      listModels: () => agent.listModels(),
      run: (opts: RunOptions) => agent.run(opts),
    };
    const external = {
      preflight: async () => null,
      trigger: async (req: { runId: string }) => {
        await new ExternalRunStore(dataRoot).complete(req.runId, { status: "ok", report: "fine" });
        return { ok: true as const, sent: "answered" as const };
      },
    };
    const settings = new SettingsStore(dataRoot);
    await settings.save({
      ...(await settings.load()),
      n8n: {
        baseUrl: "http://n8n.test:5678",
        callbackBaseUrl: "https://boof.test/boof",
        defaultTimeoutMs: 600_000,
      },
    });
    engine = new RunnerEngine({
      root: dataRoot,
      pollIntervalMs: 10,
      registry: new ToolRegistry([new MockTool(), wrapped]),
      agentAuth: { decide } as never,
      external: external as never,
    });
    const agentTools = {
      ...fm().tools,
      developer: { tool: "claude-agent", model: "default" },
    };
    await store.create(newTask(fm({ id: "normal", priority: 60, tools: agentTools }), "Work."));
    await store.create(
      newTask(
        fm({
          id: "chk",
          priority: 90,
          tools: agentTools,
          n8nCheck: {
            workflowId: "wf1",
            workflowName: "Nightly",
            webhookPath: "boof/check",
            updatedAt: "2026-06-04T10:00:00.000Z",
          },
        }),
        "Check.",
      ),
    );
    const result = await engine.tick();
    expect(result).toMatchObject({ kind: "ran", outcome: { kind: "done" } });
    expect((await store.get("chk"))?.frontmatter.status).toBe("done");
    expect((await store.get("chk"))?.body.log).not.toContain("### Not started");
    expect(decide).not.toHaveBeenCalled();
    // The gated task is refused as before.
    await engine.tick();
    expect((await store.get("normal"))?.frontmatter.status).toBe("failed");
    expect((await store.get("normal"))?.body.log).toContain("agent tool unavailable");
  });

  it("refuses a task whose role tool is not installed, instead of a spawn error", async () => {
    const mock = new MockTool();
    const missing = {
      id: "ghost",
      displayName: "Ghost",
      defaultModels: ["g"],
      installed: async () => ({ installed: false, message: "`ghost` not found on PATH" }),
      detect: () => mock.detect(),
      listModels: () => mock.listModels(),
      run: (opts: RunOptions) => mock.run(opts),
    };
    engine = new RunnerEngine({
      root: dataRoot,
      registry: new ToolRegistry([mock, missing]),
    });
    await store.create(
      newTask(
        fm({ tools: { ...fm().tools, developer: { tool: "ghost", model: "g" } } }),
        "Needs ghost.",
      ),
    );
    const result = await engine.tick();
    expect(result.kind).toBe("idle");
    const task = await store.get("t1");
    expect(task?.frontmatter.status).toBe("failed");
    expect(task?.body.log).toContain("tool_not_installed: ghost (role developer)");
    expect(mockState.calls).toEqual([]);
  });

  describe("start checks use only the roles the task runs", () => {
    const ghost = {
      id: "ghost",
      displayName: "Ghost",
      defaultModels: ["g"],
      installed: async () => ({ installed: false, message: "`ghost` not found on PATH" }),
      detect: () => new MockTool().detect(),
      listModels: () => new MockTool().listModels(),
      run: (opts: RunOptions) => new MockTool().run(opts),
    };
    const mockPick = { tool: "mock", model: "mock-default" };
    const ghostPick = { tool: "ghost", model: "g" };

    const noTools = (): TaskFrontmatter => {
      const { tools: _t, ...rest } = fm();
      return rest;
    };

    async function useSettings(profileRoles: Record<string, unknown> | null) {
      await new SettingsStore(dataRoot).save({
        ...defaultSettings(),
        runner: { enabled: true, concurrency: 1 },
        defaultProject: "default",
        roles: { planner: ghostPick, developer: mockPick, reviewer: ghostPick },
        ...(profileRoles
          ? {
              profiles: [{ id: "dev-only", name: "Developer only", roles: profileRoles }],
              activeProfile: "dev-only",
            }
          : {}),
      } as never);
      engine = new RunnerEngine({
        root: dataRoot,
        registry: new ToolRegistry([new MockTool(), ghost]),
      });
    }

    it("does not check a role the active profile switched off", async () => {
      await useSettings({ planner: null, developer: mockPick, observer: null, reviewer: null });
      await store.create(newTask(noTools(), "Develop."));
      await engine.tick();
      const task = await store.get("t1");
      expect(task?.body.log).not.toContain("tool_not_installed");
      expect(task?.frontmatter.status).toBe("done");
    });

    it("still refuses a role the profile keeps when its tool is missing", async () => {
      await useSettings({
        planner: ghostPick,
        developer: mockPick,
        observer: null,
        reviewer: null,
      });
      await store.create(newTask(noTools(), "Develop."));
      await engine.tick();
      const task = await store.get("t1");
      expect(task?.frontmatter.status).toBe("failed");
      expect(task?.body.log).toContain("tool_not_installed: ghost (role planner)");
    });

    it("checks only the planner for a plan-draft task", async () => {
      await useSettings(null);
      await store.create(
        newTask(
          fm({
            tools: { planner: mockPick },
            draftFor: { planId: "the-plan", planVersion: 1 },
          }),
          "Draft.",
        ),
      );
      await engine.tick();
      const task = await store.get("t1");
      expect(task?.body.log).not.toContain("tool_not_installed");
    });
  });

  it("fails desktop-unavailable claude-agent selection without asking for auth", async () => {
    const decide = vi.fn(async () => ({ ok: false as const, reason: "should not decide" }));
    engine = new RunnerEngine({
      root: dataRoot,
      registry: new ToolRegistry(
        defaultTools({ claudeAgentUnavailable: DESKTOP_CLAUDE_AGENT_REASON }),
      ),
      agentAuth: { decide } as never,
    });
    await store.create(
      newTask(
        fm({ tools: { ...fm().tools, reviewer: { tool: "claude-agent", model: "default" } } }),
        "Unavailable.",
      ),
    );
    const noteGoalStatus = vi.spyOn(engine as any, "noteGoalTaskStatus");
    const result = await engine.tick();
    expect(result.kind).toBe("idle");
    expect((await store.get("t1"))?.body.log).toContain(
      `### Not started\n${DESKTOP_CLAUDE_AGENT_REASON}`,
    );
    expect(decide).not.toHaveBeenCalled();
    expect(noteGoalStatus).toHaveBeenCalledWith(project, expect.anything(), "failed");
    expect(await exists(wtPath("t1"))).toBe(false);
  });

  it("refuses a missing Agent SDK at selection and records the reason", async () => {
    const reason = "The Claude Agent SDK (@anthropic-ai/claude-agent-sdk) is not installed";
    const decide = vi.fn(async () => ({ ok: false as const, reason: "should not decide" }));
    engine = new RunnerEngine({
      root: dataRoot,
      registry: new ToolRegistry([
        new MockTool(),
        new ClaudeAgentTool({
          loadSdk: async () => {
            throw new Error(reason);
          },
        }),
      ]),
      agentAuth: { decide } as never,
    });
    await store.create(
      newTask(
        fm({ tools: { ...fm().tools, developer: { tool: "claude-agent", model: "default" } } }),
        "Unavailable SDK.",
      ),
    );
    const noteGoalStatus = vi.spyOn(engine as any, "noteGoalTaskStatus");
    expect((await engine.tick()).kind).toBe("idle");
    expect((await store.get("t1"))?.frontmatter.status).toBe("failed");
    expect((await store.get("t1"))?.body.log).toContain(`### Not started\n${reason}`);
    expect(decide).not.toHaveBeenCalled();
    expect(noteGoalStatus).toHaveBeenCalledWith(project, expect.anything(), "failed");
    expect(await exists(wtPath("t1"))).toBe(false);
  });

  it("rechecks auth before the agent step and keeps its worktree when eligibility flips", async () => {
    const reason =
      'claude-agent cannot start: account "New OAuth account" is anthropic. subscription (OAuth) accounts stay on the claude-code CLI.';
    let checks = 0;
    const decide = async () =>
      ++checks === 1
        ? ({ ok: true, via: "project-key" as const } as const)
        : ({ ok: false, reason } as const);
    const auth = {
      decide,
      credentials: async () => ({
        kind: "project-key" as const,
        apiKey: "sk-ant-api03-abcdefghijklmnop",
      }),
      configDir: async () => join(dataRoot, "claude-agent-config", project.id),
    };
    const mock = new MockTool();
    const claudeAgent = {
      id: "claude-agent",
      displayName: "Claude Agent",
      defaultModels: ["default"],
      needsAgentAuth: true,
      installed: () => mock.installed(),
      detect: () => mock.detect(),
      listModels: () => mock.listModels(),
      run: (opts: RunOptions) => mock.run(opts),
    };
    engine = new RunnerEngine({
      root: dataRoot,
      registry: new ToolRegistry([new MockTool(), claudeAgent]),
      agentAuth: auth as never,
    });
    await store.create(
      newTask(
        fm({ tools: { ...fm().tools, developer: { tool: "claude-agent", model: "default" } } }),
        "Agent work.",
      ),
    );
    const result = await engine.tick();
    expect(result.kind).toBe("ran");
    expect(checks).toBe(3); // selection, gateway routing check, then fresh pre-spawn decision
    const task = await store.get("t1");
    expect(task?.frontmatter.status).toBe("failed");
    expect(task?.body.log).toContain(reason);
    expect(task?.body.log).not.toContain("sk-ant-api03-abcdefghijklmnop");
    expect(await exists(wtPath("t1"))).toBe(true);
  });

  it("passes project-key credentials and a per-project config directory to claude-agent", async () => {
    const apiKey = "sk-ant-api03-abcdefghijklmnop";
    await new ProjectKeyStore(dataRoot).set(project.id, apiKey);
    let seenAgentOptions: RunOptions | undefined;
    const mock = new MockTool();
    const claudeAgent = {
      id: "claude-agent",
      displayName: "Claude Agent",
      defaultModels: ["default"],
      needsAgentAuth: true,
      installed: () => mock.installed(),
      detect: () => mock.detect(),
      listModels: () => mock.listModels(),
      run: (opts: RunOptions) => {
        seenAgentOptions = opts;
        return mock.run(opts);
      },
    };
    const auth = new AgentAuthResolver({
      root: dataRoot,
      loadSettings: () => new SettingsStore(dataRoot).load(),
      readGatewayKey: async () => null,
    });
    engine = new RunnerEngine({
      root: dataRoot,
      registry: new ToolRegistry([new MockTool(), claudeAgent]),
      agentAuth: auth as never,
    });
    await store.create(
      newTask(
        fm({ tools: { ...fm().tools, developer: { tool: "claude-agent", model: "default" } } }),
        "Agent work.",
      ),
    );
    await engine.tick();
    expect((await store.get("t1"))?.frontmatter.status).toBe("done");
    expect((await store.get("t1"))?.body.log).toContain(
      "better-ccflare gateway not used: no better-ccflare gateway is configured; using the project's API key",
    );
    expect(seenAgentOptions?.agentAuth?.kind).toBe("project-key");
    expect(seenAgentOptions?.env?.ANTHROPIC_API_KEY).toBe(apiKey);
    expect(seenAgentOptions?.claudeConfigDir).toBe(
      join(dataRoot, "claude-agent-config", project.id),
    );
    expect(seenAgentOptions?.claudeConfigDir).not.toBe(seenAgentOptions?.cwd);
    expect((await store.get("t1"))?.body.log).not.toContain(apiKey);
  });

  it("counts gateway-authenticated Agent SDK tasks under the existing pool health gate", async () => {
    const check = vi.fn(async () => ({
      blocked: true,
      pool: { status: "degraded", reason: "pool health is degraded" },
      policy: "pause",
    }));
    const auth = {
      decide: async () => ({ ok: true as const, via: "gateway" as const }),
    };
    const mock = new MockTool();
    const claudeAgent = {
      id: "claude-agent",
      displayName: "Claude Agent",
      defaultModels: ["default"],
      needsAgentAuth: true,
      installed: () => mock.installed(),
      detect: () => mock.detect(),
      listModels: () => mock.listModels(),
      run: (opts: RunOptions) => mock.run(opts),
    };
    engine = new RunnerEngine({
      root: dataRoot,
      registry: new ToolRegistry([new MockTool(), claudeAgent]),
      agentAuth: auth as never,
      pool: { check, announceIfBlocked: vi.fn() } as never,
    });
    await store.create(
      newTask(
        fm({ tools: { ...fm().tools, developer: { tool: "claude-agent", model: "default" } } }),
        "Agent work.",
      ),
    );
    expect(await engine.tick()).toMatchObject({ kind: "pool", status: "degraded" });
    expect(check).toHaveBeenCalledOnce();
    expect((await store.get("t1"))?.frontmatter.status).toBe("pending");
    expect(await exists(wtPath("t1"))).toBe(false);
  });
});
describe("task work is never destroyed", () => {
  it("done: keeps the branch with the agent's commit and removes the clean directory", async () => {
    mockState.onRun = async (opts) => {
      if (opts.role === "developer") await commitIn(opts, "a.txt");
    };
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();

    expect((await gitOut(["rev-parse", "--verify", "refs/heads/boof-runner/t1"])).code).toBe(0);
    expect((await gitOut(["log", "--format=%s", "boof-runner/t1"])).stdout).toContain("agent");
    expect(await exists(wtPath())).toBe(false);
    const done = await store.get("t1");
    expect(done?.body.log).toMatch(/Task branch boof-runner\/t1 at [0-9a-f]{40}/);
  });

  it("done with leftovers: task branch untouched, leftovers on the side branch, directory removed", async () => {
    mockState.onRun = async (opts) => {
      if (opts.role === "developer") {
        await commitIn(opts, "a.txt");
        await writeIn(opts, "left.txt");
        await mkdir(join(opts.cwd, "scratch"), { recursive: true });
        await writeIn(opts, "scratch/note.txt");
      }
    };
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();

    const head = (await gitOut(["rev-parse", "boof-runner/t1"])).stdout.trim();
    expect((await gitOut(["log", "-1", "--format=%s", "boof-runner/t1"])).stdout.trim()).toBe(
      "agent",
    );
    expect((await gitOut(["show", "boof-runner/t1:left.txt"])).code).not.toBe(0);
    const side = (await gitOut(["rev-parse", "boof-runner/t1--leftovers"])).stdout.trim();
    expect(side).toMatch(/^[0-9a-f]{40}$/);
    expect((await gitOut(["rev-parse", `${side}^`])).stdout.trim()).toBe(head);
    expect((await gitOut(["show", "boof-runner/t1--leftovers:left.txt"])).code).toBe(0);
    expect(await exists(wtPath())).toBe(false);
    const done = await store.get("t1");
    expect(done?.body.log).toContain(`Leftovers committed to boof-runner/t1--leftovers at ${side}`);
  });

  it("done with a nested git repository: keeps the directory and says why", async () => {
    mockState.onRun = async (opts) => {
      if (opts.role === "developer") {
        await commitIn(opts, "a.txt");
        await mkdir(join(opts.cwd, "scratch", "nested"), { recursive: true });
        await gitOut(["init", "-b", "main"], join(opts.cwd, "scratch", "nested"));
        await writeIn(opts, "scratch/nested/f.txt");
      }
    };
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();

    expect(await exists(join(wtPath(), "scratch", "nested", "f.txt"))).toBe(true);
    const log = (await store.get("t1"))?.body.log ?? "";
    expect(log).toContain("nested git repositories are not saved");
    expect(log).not.toContain("Removed worktree directory");
  });

  it("failure: keeps the directory, the branch and uncommitted changes", async () => {
    mockState.onRun = async (opts) => {
      if (opts.role === "planner") await writeIn(opts, "wip.txt");
    };
    mockState.failRole = "developer";
    await store.create(newTask(fm(), "will fail"));
    const r = await engine.tick();
    expect(r.kind).toBe("ran");
    if (r.kind === "ran") expect(r.outcome.kind).toBe("failed");

    expect(await exists(join(wtPath(), "wip.txt"))).toBe(true);
    expect((await gitOut(["status", "--porcelain"], wtPath())).stdout).toContain("wip.txt");
    expect((await gitOut(["rev-parse", "--verify", "refs/heads/boof-runner/t1"])).code).toBe(0);
    const failed = await store.get("t1");
    expect(failed?.body.log).toMatch(/Kept worktree .* on branch boof-runner\/t1 at [0-9a-f]{40}/);
  });

  it("multi-run: iteration 2 sees iteration 1's work in the same worktree", async () => {
    let iter2Saw: boolean | null = null;
    const cwds = new Set<string>();
    mockState.onRun = async (opts) => {
      if (opts.role !== "developer") return;
      cwds.add(opts.cwd);
      if (!existsSync(join(opts.cwd, "iter1.txt"))) await writeIn(opts, "iter1.txt");
      else iter2Saw = true;
    };
    await store.create(newTask(fm({ runs: 2 }), "twice"));
    await engine.tick();
    await engine.tick();

    expect(iter2Saw).toBe(true);
    expect(cwds.size).toBe(1);
    expect((await gitOut(["show", "boof-runner/t1--leftovers:iter1.txt"])).code).toBe(0);
  });

  it("unregistered directory at the worktree path: fails clearly, leaves it untouched", async () => {
    await mkdir(wtPath(), { recursive: true });
    await writeFile(join(wtPath(), "keep.txt"), "sentinel");
    await store.create(newTask(fm(), "Build it."));
    const r = await engine.tick();
    expect(r.kind).toBe("ran");
    if (r.kind === "ran") {
      expect(r.outcome.kind).toBe("failed");
      if (r.outcome.kind === "failed") expect(r.outcome.error).toContain(wtPath());
    }
    expect(await readFile(join(wtPath(), "keep.txt"), "utf8")).toBe("sentinel");
    expect(
      (await gitOut(["rev-parse", "--verify", "--quiet", "refs/heads/boof-runner/t1"])).code,
    ).not.toBe(0);
  });

  it("retry: reuses the kept branch and its earlier commit", async () => {
    const cwds: string[] = [];
    mockState.onRun = async (opts) => {
      if (opts.role !== "developer") return;
      cwds.push(opts.cwd);
      if (!existsSync(join(opts.cwd, "a.txt"))) await commitIn(opts, "a.txt");
    };
    mockState.failRole = "reviewer";
    await store.create(newTask(fm(), "Build it."));
    const first = await engine.tick();
    if (first.kind === "ran") expect(first.outcome.kind).toBe("failed");
    const sha1 = (await gitOut(["rev-parse", "boof-runner/t1"])).stdout.trim();

    await store.transition("t1", "pending");
    mockState.failRole = null;
    const second = await engine.tick();
    if (second.kind === "ran") expect(second.outcome.kind).toBe("done");

    expect((await gitOut(["merge-base", "--is-ancestor", sha1, "boof-runner/t1"])).code).toBe(0);
    expect((await gitOut(["show", "boof-runner/t1:a.txt"])).code).toBe(0);
    expect(cwds).toEqual([wtPath(), wtPath()]);
  });
});
describe("retention policies", () => {
  const withWorktree = async (worktree: {
    root?: string;
    onDone?: "keep-branch" | "keep" | "delete";
    onFailure?: "keep" | "delete";
  }) => {
    const store = new SettingsStore(dataRoot);
    const cur = await store.load();
    await store.save({
      ...cur,
      worktree: { onDone: "keep-branch", onFailure: "keep", ...worktree },
    });
  };
  const hasBranch = async (b: string) =>
    (await gitOut(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])).code === 0;
  const dirty = (role: string) => async (opts: RunOptions) => {
    if (opts.role === role) {
      await commitIn(opts, "a.txt");
      await writeIn(opts, "left.txt");
    }
  };

  it("defaults: a failed task keeps directory and branch; a done task keeps the branch only", async () => {
    mockState.failRole = "developer";
    await store.create(newTask(fm(), "fail"));
    await engine.tick();
    expect(await exists(wtPath())).toBe(true);
    expect(await hasBranch("boof-runner/t1")).toBe(true);
  });

  it("onDone=keep: leaves the directory (dirty) and saves leftovers on the side branch", async () => {
    await withWorktree({ onDone: "keep" });
    mockState.onRun = dirty("developer");
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();
    expect(await exists(join(wtPath(), "left.txt"))).toBe(true);
    expect(await hasBranch("boof-runner/t1")).toBe(true);
    expect((await gitOut(["show", "boof-runner/t1--leftovers:left.txt"])).code).toBe(0);
    expect((await gitOut(["show", "boof-runner/t1:left.txt"])).code).not.toBe(0);
  });

  it("onDone=delete: removes directory and branches and logs loudly", async () => {
    await withWorktree({ onDone: "delete" });
    mockState.onRun = dirty("developer");
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();
    expect(await exists(wtPath())).toBe(false);
    expect(await hasBranch("boof-runner/t1")).toBe(false);
    expect(await hasBranch("boof-runner/t1--leftovers")).toBe(false);
    const done = await store.get("t1");
    expect(done?.frontmatter.status).toBe("done");
    expect(done?.body.log).toContain("WARNING: DELETED task work");
  });

  it("onFailure=keep (explicit): keeps directory and branch", async () => {
    await withWorktree({ onFailure: "keep" });
    mockState.failRole = "developer";
    await store.create(newTask(fm(), "fail"));
    await engine.tick();
    expect(await exists(wtPath())).toBe(true);
    expect(await hasBranch("boof-runner/t1")).toBe(true);
  });

  it("onFailure=delete: removes directory and branch and logs loudly", async () => {
    await withWorktree({ onFailure: "delete" });
    mockState.onRun = dirty("planner");
    mockState.failRole = "developer";
    await store.create(newTask(fm(), "fail"));
    const r = await engine.tick();
    if (r.kind === "ran") expect(r.outcome.kind).toBe("failed");
    expect(await exists(wtPath())).toBe(false);
    expect(await hasBranch("boof-runner/t1")).toBe(false);
    expect((await store.get("t1"))?.body.log).toContain("WARNING: DELETED task work");
  });

  it("onFailure=delete never deletes a stopped task's work", async () => {
    await withWorktree({ onFailure: "delete" });
    await store.create(newTask(fm(), "Build it."));
    const running = await store.transition("t1", "running");
    await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
    await writeFile(taskStopRequestPath(projectDir, "t1"), "stop\n");
    const pipeline = new Pipeline({
      root: projectDir,
      store: store,
      registry: engine.registry,
      settings: effectiveSettings(await engine.settingsStore.load(), project),
    });
    const outcome = await pipeline.run(running);
    expect(outcome.kind).toBe("stopped");
    expect(await exists(wtPath())).toBe(true);
    expect(await hasBranch("boof-runner/t1")).toBe(true);
  });

  it("worktree.root outside the repository: worktree and sidecar live there", async () => {
    const outside = await mkdtemp(join(tmpdir(), "boof-runner-wtroot-"));
    try {
      await withWorktree({ root: outside, onDone: "keep" });
      const cwds: string[] = [];
      mockState.onRun = async (opts) => void cwds.push(opts.cwd);
      await store.create(newTask(fm(), "Build it."));
      await engine.tick();
      expect(cwds.every((c) => c === join(outside, "t1"))).toBe(true);
      expect(await exists(join(outside, "t1"))).toBe(true);
      expect(await exists(join(outside, ".meta", "t1.json"))).toBe(true);
      expect(await exists(join(workDir, ".boof-runner-worktrees"))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
describe("base ref (mock tool)", () => {
  it("starts from base, logs the resolved sha, and the diff excludes earlier commits", async () => {
    await gitOut(["branch", "release"]);
    await writeFile(join(workDir, "later.txt"), "later\n");
    await gitOut(["add", "."]);
    await gitOut(["commit", "-m", "later"]);
    const baseSha = (await gitOut(["rev-parse", "release"])).stdout.trim();
    let sawLater: boolean | null = null;
    mockState.onRun = async (opts) => {
      if (opts.role === "developer") sawLater = existsSync(join(opts.cwd, "later.txt"));
    };
    await store.create(newTask(fm({ base: "release" }), "Build it."));
    await engine.tick();
    expect(sawLater).toBe(false);
    expect((await gitOut(["merge-base", "--is-ancestor", baseSha, "boof-runner/t1"])).code).toBe(0);
    expect((await gitOut(["rev-parse", "boof-runner/t1"])).stdout.trim()).toBe(baseSha);
    expect((await store.get("t1"))?.body.log).toContain(`base release → ${baseSha}`);
  });

  it("without a base the log names the branch checked out in the project", async () => {
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();
    const head = (await gitOut(["rev-parse", "HEAD"])).stdout.trim();
    const branch = (await gitOut(["symbolic-ref", "--short", "HEAD"])).stdout.trim();
    expect((await store.get("t1"))?.body.log).toContain(`base ${branch} → ${head}`);
  });

  it("an unknown base fails the task clearly and creates nothing", async () => {
    await store.create(newTask(fm({ base: "no-such-ref" }), "Build it."));
    const r = await engine.tick();
    expect(r.kind).toBe("ran");
    if (r.kind === "ran" && r.outcome.kind === "failed") {
      expect(r.outcome.error).toContain("unknown base ref 'no-such-ref'");
    } else throw new Error("expected failed");
    expect(await exists(wtPath())).toBe(false);
    expect(await exists(join(workDir, ".boof-runner-worktrees"))).toBe(false);
    expect((await gitOut(["branch", "--list", "boof-runner/*"])).stdout.trim()).toBe("");
  });

  it("a reused branch ignores base and the log says so", async () => {
    mockState.failRole = "reviewer";
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();
    await gitOut(["branch", "other"]);
    const t = await store.get("t1");
    t!.frontmatter.base = "other";
    await store.save(t!);
    await store.transition("t1", "pending");
    mockState.failRole = null;
    await engine.tick();
    expect((await store.get("t1"))?.body.log).toContain(
      "base other ignored: reusing existing branch boof-runner/t1",
    );
  });
});
