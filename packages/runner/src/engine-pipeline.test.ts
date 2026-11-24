import { chmod, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CommandStore,
  currentStatus,
  effectiveSettings,
  newTask,
  parseGoal,
  TaskStore,
  taskControlDir,
  taskFilePath,
  taskPromptInjectionsPath,
  taskStopRequestPath,
  workingAreaDir,
  type Project,
  appendAnswerRound,
} from "@boof/heart";
import { RunnerEngine } from "./engine.js";
import { Pipeline, SYSTEM_PROMPTS } from "./pipeline.js";
import { ensureWorktree } from "./worktree.js";
import { ToolRunError } from "./tools/errors.js";
import { MockTool, mockState } from "./tools/mock.js";
import { CodexTool } from "./tools/codex.js";
import { ToolRegistry } from "./tools/registry.js";
import { useEngineRig, exists, wtPath, gitOut, fm } from "./engine-test-support.js";

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
  it("runs the full happy-path pipeline to done with all reports", async () => {
    await store.create(newTask(fm(), "Build a thing."));
    const r = await engine.tick();
    expect(r.kind).toBe("ran");
    if (r.kind === "ran") expect(r.outcome.kind).toBe("done");

    // Task moved to done/.
    expect(await exists(taskFilePath(projectDir, "done", "t1"))).toBe(true);
    const done = await store.get("t1");
    expect(done?.frontmatter.status).toBe("done");

    // Reports + plan written into the working area (kept under ongoing? no — moved).
    // The transition to done removed the working area; assert reports were mirrored
    // into the task body instead.
    expect(done?.body.reports.planner).toContain("Plan");
    expect(done?.body.reports.developer).toContain("Developer report");
    expect(done?.body.reports.reviewer).toContain("Review");
    expect(done?.frontmatter.tokens?.known).toBe(true);
  });

  it("records each pipeline step with a time", async () => {
    await store.create(newTask(fm(), "Build a thing."));
    await engine.tick();
    const done = (await store.get("t1"))!;
    const steps = done.frontmatter.steps!;
    const labels = steps.map((s) => s.label);
    expect(labels.slice(0, 3)).toEqual(["Planner", "Planner (refinement)", "Developer"]);
    expect(labels.some((l) => l.startsWith("Reviewer (round 1"))).toBe(true);
    const times = steps.map((s) => Date.parse(s.at));
    expect(times.every((t) => !Number.isNaN(t))).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(Date.parse(done.frontmatter.startedAt!)).toBeLessThanOrEqual(times[0]!);
  });

  it("a run ends with exactly one closing step entry: Finished or Failed", async () => {
    const labels = async (id: string) =>
      (await store.get(id))!.frontmatter.steps!.map((s) => s.label);
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();
    expect(await labels("t1")).toEqual([
      "Planner",
      "Planner (refinement)",
      "Developer",
      "Reviewer (round 1)",
      "Finished",
    ]);
    const steps = (await store.get("t1"))!.frontmatter.steps!;
    expect(Date.parse(steps.at(-1)!.at)).toBeGreaterThanOrEqual(Date.parse(steps.at(-2)!.at));

    mockState.failRole = "developer";
    await store.create(newTask(fm({ id: "t2" }), "Build it."));
    await engine.tick();
    expect(await labels("t2")).toEqual(["Planner", "Planner (refinement)", "Developer", "Failed"]);
  });

  it("a run whose closing bookkeeping throws ends with Failed only, never Finished then Failed", async () => {
    mockState.onRun = async (opts) => {
      // The usage aggregate cannot be written: persistUsage throws after the work is done.
      if (opts.role === "reviewer")
        await mkdir(join(projectDir, "usage.json"), { recursive: true });
    };
    await store.create(newTask(fm(), "Build it."));
    const r = await engine.tick();
    expect(r.kind === "ran" ? r.outcome.kind : r.kind).toBe("failed");
    const steps = (await store.get("t1"))!.frontmatter.steps!.map((s) => s.label);
    expect(steps.filter((l) => ["Finished", "Failed", "Stopped"].includes(l))).toEqual(["Failed"]);
  });

  it("respects skip and priority ordering", async () => {
    await store.create(newTask(fm({ id: "low", priority: 10 }), "low"));
    await store.create(newTask(fm({ id: "high", priority: 90 }), "high"));
    await store.create(newTask(fm({ id: "skipped", priority: 99, skip: true }), "skip"));
    const next = await engine.selectNext();
    expect(next?.task.frontmatter.id).toBe("high");
    expect(next?.project.id).toBe("default");
  });

  it("does not run when disabled", async () => {
    await engine.settingsStore.update({ runner: { enabled: false } });
    await store.create(newTask(fm(), "x"));
    const r = await engine.tick();
    expect(r.kind).toBe("disabled");
    expect(await exists(taskFilePath(projectDir, "pending", "t1"))).toBe(true);
  });

  it("parks on planner questions, then resumes to done after answers", async () => {
    mockState.plannerQuestions = ["Which database?"];
    await store.create(newTask(fm(), "Build with a DB."));

    // First tick: planner asks → parked in actions/.
    const first = await engine.tick();
    expect(first.kind).toBe("ran");
    if (first.kind === "ran") expect(first.outcome.kind).toBe("parked");
    expect(await exists(taskFilePath(projectDir, "action", "t1"))).toBe(true);
    const parked = await store.get("t1");
    expect(parked?.frontmatter.status).toBe("action");
    expect(parked?.frontmatter.questions).toBe("pending");
    expect(parked?.frontmatter.steps?.map((s) => s.label)).toEqual(["Planner"]);
    expect(parked?.body.questions).toContain("Which database?");

    // User answers (simulate the Actions tab): write answers, set answered, move to pending.
    await store.transition("t1", "pending", (t) => {
      t.body.answers = "Use Postgres.";
      t.frontmatter.questions = "answered";
    });

    // Second tick: planner no longer asks (mock ask-once) → completes.
    const second = await engine.tick();
    expect(second.kind).toBe("ran");
    if (second.kind === "ran") expect(second.outcome.kind).toBe("done");
    const done = await store.get("t1");
    expect(done?.frontmatter.status).toBe("done");
    expect(done?.frontmatter.questions).toBe("answered");
  });

  it("parks again when the planner asks again on a resumed run", async () => {
    mockState.plannerQuestions = ["Which database?"];
    await store.create(newTask(fm(), "Build with a DB."));
    await engine.tick();
    await store.transition("t1", "pending", (t) => {
      t.body.answers = "Use Postgres.";
      t.frontmatter.questions = "answered";
    });
    mockState.plannerQuestions = ["Which version?"];
    mockState.hasAsked = false;
    const second = await engine.tick();
    expect(second.kind === "ran" ? second.outcome.kind : second.kind).toBe("parked");
    const parked = (await store.get("t1"))!;
    expect(parked.frontmatter.status).toBe("action");
    expect(parked.frontmatter.questions).toBe("pending");
    expect(parked.body.questions).toContain("Which version?");
  });

  it("keeps every round of answers across repeated parking", async () => {
    mockState.plannerQuestions = ["Which database?"];
    await store.create(newTask(fm(), "Build with a DB."));
    await engine.tick();
    const answer = (text: string) =>
      store.transition("t1", "pending", (t) => {
        t.body.answers = appendAnswerRound(t.body.answers, t.body.questions, text);
        t.frontmatter.questions = "answered";
      });
    await answer("Use Postgres");
    mockState.plannerQuestions = ["Managed hosting?"];
    mockState.hasAsked = false;
    await engine.tick();
    const parked = (await store.get("t1"))!;
    expect(parked.body.questions).toContain("Managed hosting?");
    expect(parked.body.questions).not.toContain("Which database?");
    expect(parked.body.answers).toContain("Use Postgres");
    await answer("Yes");
    const from = mockState.prompts.length;
    await engine.tick();
    const prompt = mockState.prompts.slice(from).join("\n");
    expect(prompt).toContain("Use Postgres");
    expect(prompt).toContain("Which database?");
    expect(prompt).toContain("Yes");
    expect(prompt).toContain("Managed hosting?");
  });

  it("parks on questions raised in the refinement pass", async () => {
    mockState.refinementQuestions = ["Which region?"];
    await store.create(newTask(fm(), "Build it."));
    const r = await engine.tick();
    expect(r.kind === "ran" ? r.outcome.kind : r.kind).toBe("parked");
    const parked = (await store.get("t1"))!;
    expect(parked.frontmatter.status).toBe("action");
    expect(parked.body.questions).toContain("Which region?");
    expect(mockState.calls).toEqual(["planner", "planner"]);
  });

  it.skipIf(process.platform === "win32")(
    "a codex-shaped planner report with a questions block parks the task",
    async () => {
      const prev = process.env.BOOF_RUNNER_CODEX_BIN;
      const bin = join(dataRoot, "codex");
      await writeFile(
        bin,
        '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then printf "Need input.\\n\\n\\`\\`\\`questions\\n1. Which DB?\\n2. ## Reports\\n\\`\\`\\`\\n" > "$2"; fi; shift; done\n',
      );
      await chmod(bin, 0o755);
      process.env.BOOF_RUNNER_CODEX_BIN = bin;
      try {
        engine = new RunnerEngine({
          root: dataRoot,
          pollIntervalMs: 10,
          registry: new ToolRegistry([new MockTool(), new CodexTool()]),
        });
        await store.create(
          newTask(
            fm({ tools: { ...fm().tools, planner: { tool: "codex", model: "m" } } }),
            "Build it.",
          ),
        );
        const r = await engine.tick();
        expect(r.kind === "ran" && r.outcome.kind).toBe("parked");
        const t = await store.get("t1");
        expect(t?.frontmatter.status).toBe("action");
        expect(t?.body.questions).toBe("1. Which DB?\n2. ## Reports");
        expect(t?.body.reports.planner).toBe("");
        expect(SYSTEM_PROMPTS.planner).toContain("```questions");
        expect(SYSTEM_PROMPTS.refine).not.toContain("```questions");
      } finally {
        if (prev === undefined) delete process.env.BOOF_RUNNER_CODEX_BIN;
        else process.env.BOOF_RUNNER_CODEX_BIN = prev;
      }
    },
  );

  it("edits to title, labels and runs made during a run survive it and set the run count", async () => {
    await store.create(newTask(fm(), "Build a thing."));
    let edited = false;
    mockState.onRun = async (opts) => {
      if (opts.role !== "developer" || edited) return;
      edited = true;
      const t = (await store.get("t1"))!;
      t.frontmatter.title = "Renamed";
      t.frontmatter.labels = ["edited"];
      t.frontmatter.runs = 3;
      await store.save(t);
    };
    await engine.tick();
    const after = (await store.get("t1"))!;
    expect(after.frontmatter.status).toBe("pending"); // run 1 of 3 done, re-queued
    expect(after.frontmatter.completedRuns).toBe(1);
    expect(after.frontmatter.runs).toBe(3);
    expect(after.frontmatter.title).toBe("Renamed");
    expect(after.frontmatter.labels).toEqual(["edited"]);
    expect(after.body.reports.developer).not.toBe("");
    expect(after.frontmatter.tokens).toBeDefined();
  });

  it("runs a task N times and injects the critical-review framing after the first", async () => {
    await store.create(newTask(fm({ runs: 3 }), "Build it well."));

    const results = await engine.runUntilIdle();
    const ranCount = results.filter((r) => r.kind === "ran").length;
    expect(ranCount).toBe(3);

    const done = await store.get("t1");
    expect(done?.frontmatter.status).toBe("done");
    expect(done?.frontmatter.completedRuns).toBe(3);

    // Iteration 1 prompts carry no framing; iterations 2 and 3 do.
    const framed = mockState.prompts.filter((p) => p.includes("Iteration "));
    expect(framed.some((p) => p.includes("Iteration 2 of 3"))).toBe(true);
    expect(framed.some((p) => p.includes("Iteration 3 of 3"))).toBe(true);
    expect(framed.some((p) => p.includes("another AI's solution"))).toBe(true);
    // The very first planner prompt must NOT be framed.
    expect(mockState.prompts[0]).not.toContain("Iteration ");
  });

  it("re-queues to pending between runs rather than finishing early", async () => {
    await store.create(newTask(fm({ runs: 2 }), "twice"));
    const first = await engine.tick();
    expect(first.kind).toBe("ran");
    // After one run of a 2-run task, it should be back in pending, not done.
    const mid = await store.get("t1");
    expect(mid?.frontmatter.status).toBe("pending");
    expect(mid?.frontmatter.completedRuns).toBe(1);

    const second = await engine.tick();
    expect(second.kind).toBe("ran");
    const end = await store.get("t1");
    expect(end?.frontmatter.status).toBe("done");
    expect(end?.frontmatter.completedRuns).toBe(2);
  });

  it("clears a command id whose template is gone when the task leaves running, keeping its copy", async () => {
    const task = newTask(fm({ command: "gone" }), "p");
    task.body.command = "copied instructions";
    await store.create(task);
    await engine.tick();
    const done = await store.get("t1");
    expect(done?.frontmatter.status).toBe("done");
    expect(done?.frontmatter.command).toBeNull();
    expect(done?.body.command).toBe("copied instructions");
  });

  it("keeps a command id whose template still exists", async () => {
    await new CommandStore(dataRoot).upsert("Kept", "kept body");
    const task = newTask(fm({ command: "kept" }), "p");
    task.body.command = "kept body";
    await store.create(task);
    await engine.tick();
    expect((await store.get("t1"))?.frontmatter.command).toBe("kept");
  });

  it("fails the task and captures diagnostics on tool error", async () => {
    mockState.failRole = "developer";
    await store.create(newTask(fm(), "will fail"));
    const r = await engine.tick();
    expect(r.kind).toBe("ran");
    if (r.kind === "ran") expect(r.outcome.kind).toBe("failed");
    expect(await exists(taskFilePath(projectDir, "failed", "t1"))).toBe(true);

    // log.txt was moved with the working area? No — failed is a flat file. The
    // working area under ongoing/ is removed on transition; diagnostics were
    // appended during the run. Assert the failed task records the error path.
    const failed = await store.get("t1");
    expect(failed?.frontmatter.status).toBe("failed");

    // Retry returns it to pending.
    await store.transition("t1", "pending");
    expect(await exists(taskFilePath(projectDir, "pending", "t1"))).toBe(true);
  });

  it("passes injected prompts into later pipeline steps", async () => {
    await store.create(newTask(fm(), "Build it."));
    const running = await store.transition("t1", "running");
    await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
    await writeFile(
      taskPromptInjectionsPath(projectDir, "t1"),
      "## 2026-07-02T00:00:00.000Z\nAlso add a focused regression test.\n",
    );

    const pipeline = new Pipeline({
      root: projectDir,
      store: store,
      registry: engine.registry,
      settings: effectiveSettings(await engine.settingsStore.load(), project),
    });
    const outcome = await pipeline.run(running);

    expect(outcome.kind).toBe("done");
    expect(
      mockState.prompts.some(
        (p) =>
          p.includes("User prompts injected while this task was running") &&
          p.includes("Also add a focused regression test."),
      ),
    ).toBe(true);
  });

  it("hands the pool gateway to a poolable tool only, and the mock never gets one", async () => {
    const gateway = { url: "http://127.0.0.1:8080", apiKey: "ccf-client-key" };
    const seen: unknown[] = [];
    const run = async (poolable: boolean) => {
      seen.length = 0;
      // The engine's own registry maps the roles to the mock; make it poolable or not.
      const tool = engine.registry.get("mock") as { acceptsPool?: boolean };
      tool.acceptsPool = poolable;
      mockState.onRun = async (o) => void seen.push((o as { gateway?: unknown }).gateway);
      await store.create(newTask(fm({ id: poolable ? "tp" : "tn" }), "x"));
      const running = await store.transition(poolable ? "tp" : "tn", "running");
      const pipeline = new Pipeline({
        root: projectDir,
        store,
        registry: engine.registry,
        settings: effectiveSettings(await engine.settingsStore.load(), project),
        gateway,
      });
      expect((await pipeline.run(running)).kind).toBe("done");
      return [...seen];
    };
    const mock = engine.registry.get("mock") as { acceptsPool?: boolean };
    const routed = await run(true);
    expect(routed.length).toBeGreaterThan(0);
    expect(routed.every((g) => JSON.stringify(g) === JSON.stringify(gateway))).toBe(true);
    const plain = await run(false);
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.every((g) => g === undefined)).toBe(true);
    delete mock.acceptsPool;
  });

  it("in internal mode a tool that is not routed through the pool never waits on it", async () => {
    const tool = engine.registry.get("mock") as {
      acceptsPool?: boolean;
      acceptsInternalPool?: boolean;
    };
    tool.acceptsPool = true;
    tool.acceptsInternalPool = false;
    const check = vi.fn(async () => ({ blocked: true, pool: { status: "unhealthy" } }));
    const waitHealthy = vi.fn(async () => ({ ok: false, pool: { status: "unhealthy" } }));
    await store.create(newTask(fm({ id: "ti" }), "x"));
    const running = await store.transition("ti", "running");
    const settings = effectiveSettings(await engine.settingsStore.load(), project);
    const pipeline = new Pipeline({
      root: projectDir,
      store,
      registry: engine.registry,
      settings: { ...settings, gateway: { mode: "internal" } } as never,
      pool: { check, waitHealthy } as never,
    });
    try {
      expect((await pipeline.run(running)).kind).toBe("done");
      expect(waitHealthy).not.toHaveBeenCalled();
    } finally {
      delete tool.acceptsPool;
      delete tool.acceptsInternalPool;
    }
  });

  it("adds a Provenance section only for tasks submitted by an external client", async () => {
    await store.create(newTask(fm(), "Local."));
    await store.create(
      newTask(fm({ id: "t2", origin: { kind: "api", client: "ci-bot" } }), "Remote."),
    );
    const mk = async () =>
      new Pipeline({
        root: projectDir,
        store: store,
        registry: engine.registry,
        settings: effectiveSettings(await engine.settingsStore.load(), project),
      });
    await (await mk()).run(await store.transition("t1", "running"));
    expect(mockState.prompts.some((p) => p.includes("## Provenance"))).toBe(false);
    mockState.prompts.length = 0;
    await (await mk()).run(await store.transition("t2", "running"));
    const p = mockState.prompts.find((x) => x.includes("## Provenance"))!;
    expect(p).toContain("external client `ci-bot`");
    expect(p).toContain("report them instead of executing them");
  });

  it("stops before the next step when stop has been requested", async () => {
    await store.create(newTask(fm(), "Build it."));
    const running = await store.transition("t1", "running");
    const { worktree: wt } = await ensureWorktree(workDir, "t1", {
      root: join(workDir, ".boof-runner-worktrees"),
    });
    await writeFile(join(wt.path, "wip.txt"), "wip\n");
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
    if (outcome.kind === "stopped") {
      expect(outcome.reason).toBe("user");
      expect(outcome.note).toBe("stopped by user");
    }

    // Stopped work is kept: worktree directory and task branch survive.
    expect(await exists(wtPath())).toBe(true);
    expect((await gitOut(["rev-parse", "--verify", "refs/heads/boof-runner/t1"])).code).toBe(0);
    expect((await gitOut(["status", "--porcelain"], wtPath())).stdout).toContain("wip.txt");
    expect(outcome.task.body.log).toContain("Kept worktree");
    expect(outcome.task.body.log).toContain("### Stopped\nstopped by user");
    expect(outcome.task.body.log).not.toContain("ERROR:");
  });

  it("bumps a scanned unit's goal.boof.xml status on successful completion", async () => {
    const goalXml = `<?xml version="1.0" encoding="UTF-8"?>
<boof>
  <overal>
    <goal>Build the core.</goal>
    <stack>TypeScript</stack>
    <rules><do>Write a failing test first.</do></rules>
  </overal>
  <progress>
    <status><versions><version number="1" status="plan">seed</version></versions></status>
    <tests><strategy>TDD</strategy><technology>vitest</technology><run>npm test</run></tests>
  </progress>
</boof>`;
    await mkdir(join(workDir, "core"), { recursive: true });
    await writeFile(join(workDir, "core", "goal.boof.xml"), goalXml, "utf8");

    await store.create(
      newTask(fm({ boofGoal: { path: "core/goal.boof.xml", bumpTo: "done" } }), "Implement core."),
    );
    const r = await engine.tick();
    expect(r.kind).toBe("ran");
    if (r.kind === "ran") expect(r.outcome.kind).toBe("done");

    // The goal file gained a version with status done.
    const after = parseGoal(await readFile(join(workDir, "core", "goal.boof.xml"), "utf8"));
    expect(currentStatus(after)).toBe("done");
    expect(after.progress.versions).toHaveLength(2);
  });
});
describe("stopped status and durable injected prompts (mock tool)", () => {
  /** First planner call: inject a prompt (as the API does) and request a stop. */
  const stopDuringPlanner = (note?: string) => {
    let first = true;
    mockState.onRun = async () => {
      if (!first) return;
      first = false;
      await store.appendInjected("t1", "use tabs, not spaces", "alice");
      await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
      await writeFile(taskStopRequestPath(projectDir, "t1"), note ?? "stop\n");
    };
  };

  it("a user stop records the task as stopped, keeps the worktree and the injected prompt", async () => {
    stopDuringPlanner();
    await store.create(newTask(fm(), "Build it."));
    const r = await engine.tick();
    expect(r.kind === "ran" && r.outcome.kind).toBe("stopped");

    const t = await store.get("t1");
    expect(t?.frontmatter.status).toBe("stopped");
    expect(t?.frontmatter.steps?.map((s) => s.label)).toEqual(["Planner", "Stopped"]);
    expect(await exists(taskFilePath(projectDir, "stopped", "t1"))).toBe(true);
    expect(await exists(workingAreaDir(projectDir, "t1"))).toBe(false);
    expect(t?.body.log).toContain("### Stopped\nstopped by user");
    expect(await exists(wtPath())).toBe(true);
    expect(await exists(join(taskControlDir(projectDir, "t1"), "prompts.md"))).toBe(false);
    expect(t?.body.injected).toContain("alice");
    expect(t?.body.injected).toContain("use tabs, not spaces");
    const events = (await readFile(join(projectDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ type: "task.status", from: "running", to: "stopped" });
  });

  it("retrying a stopped task continues in the same worktree and re-states the injected prompt", async () => {
    stopDuringPlanner();
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();
    await writeFile(join(wtPath(), "wip.txt"), "wip\n");
    expect((await store.get("t1"))?.frontmatter.status).toBe("stopped");

    mockState.prompts = [];
    const cwds: string[] = [];
    mockState.onRun = async (opts) => void cwds.push(opts.cwd);
    await store.transition("t1", "pending");
    const r = await engine.tick();
    expect(r.kind === "ran" && r.outcome.kind).toBe("done");

    expect(cwds.every((c) => c === wtPath())).toBe(true);
    const first = mockState.prompts[0];
    expect(first).toContain("## Previous run stopped");
    expect(first).toContain("git status");
    expect(first).toContain("## Earlier injected instructions");
    expect(first).toContain("use tabs, not spaces");
    // The injected prompts stay on the finished task.
    expect((await store.get("t1"))?.body.injected).toContain("use tabs, not spaces");
  });

  it("a later retry after a completed run no longer says the run was stopped", async () => {
    stopDuringPlanner();
    await store.create(newTask(fm({ runs: 2 }), "Build it."));
    await engine.tick();
    await store.transition("t1", "pending");
    await engine.tick(); // iteration 1 completes, task re-queued for iteration 2
    mockState.prompts = [];
    mockState.onRun = null;
    await engine.tick();
    expect(mockState.prompts[0]).not.toContain("## Previous run stopped");
  });

  it("server shutdown records the task as stopped with a shutdown note", async () => {
    let started!: () => void;
    const up = new Promise<void>((r) => (started = r));
    mockState.onRun = async (opts) => {
      started();
      // Wait for the stop request like a real tool would, then fail as a stopped tool.
      for (let i = 0; i < 400; i++) {
        if (opts.stopSignalPath && (await exists(opts.stopSignalPath))) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new ToolRunError("mock", null, false, true, "stopped", "");
    };
    await store.create(newTask(fm(), "Build it."));
    const loop = engine.loop();
    await up;
    await engine.shutdown(10000);
    await loop;
    const t = await store.get("t1");
    expect(t?.frontmatter.status).toBe("stopped");
    expect(t?.body.log).toContain("### Stopped\nstopped by server shutdown");
  });

  it("a failed run still ends as failed, with its injected prompt kept", async () => {
    mockState.onRun = async () => {
      await store.appendInjected("t1", "be careful");
    };
    mockState.failRole = "developer";
    await store.create(newTask(fm(), "Build it."));
    const r = await engine.tick();
    expect(r.kind === "ran" && r.outcome.kind).toBe("failed");
    const t = await store.get("t1");
    expect(t?.frontmatter.status).toBe("failed");
    expect(t?.body.injected).toContain("be careful");
    expect(t?.body.injected).toContain("user");
  });

  it("a done run keeps its injected prompts", async () => {
    mockState.onRun = async () => {
      if (!(await store.get("t1"))?.body.injected) await store.appendInjected("t1", "one", "bot");
    };
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();
    const t = await store.get("t1");
    expect(t?.frontmatter.status).toBe("done");
    expect(t?.body.injected).toContain("bot");
  });
});
