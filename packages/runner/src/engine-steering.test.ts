import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  effectiveSettings,
  newTask,
  TaskStore,
  parseInjected,
  taskControlDir,
  taskPromptInjectionsPath,
  taskSteerRequestPath,
  taskStopRequestPath,
  workingAreaDir,
  type Project,
} from "@boof/heart";
import { RunnerEngine } from "./engine.js";
import { Pipeline } from "./pipeline.js";
import { ToolRunError } from "./tools/errors.js";
import { mockState } from "./tools/mock.js";
import type { RunOptions } from "./tools/types.js";
import { useEngineRig, exists, fm } from "./engine-test-support.js";

let engine: RunnerEngine;
/** The project under test: `workDir` registered as project `default`. */
let project: Project;
let projectDir: string;
let store: TaskStore;

useEngineRig((rig) => {
  ({ engine, project, projectDir, store } = rig);
});

describe("steering a running step (mock tool)", () => {
  const STEER_TEXT = "use tabs, not spaces";
  const liveLog = () =>
    readFile(join(workingAreaDir(projectDir, "t1"), "log.txt"), "utf8").catch(() => "");
  const devHeaders = (log: string) =>
    (log.match(/^### Developer( \(steer \d+\))?$/gm) ?? []).length;
  const devCalls = () => mockState.calls.filter((c) => c === "developer").length;

  /** What the inject API does for mode `now`: durable entry, prompts.md and the steer request. */
  const requestSteer = async (text: string) => {
    await store.appendInjected("t1", text, "user", "now");
    await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
    await appendFile(taskPromptInjectionsPath(projectDir, "t1"), `\n\n## now\n${text}\n`);
    await appendFile(
      taskSteerRequestPath(projectDir, "t1"),
      JSON.stringify({ at: new Date().toISOString(), text }) + "\n",
    );
  };

  /**
   * Run `fn` every 40 ms, like a user acting on the task. The returned stop clears the timer and
   * waits for the ticks still in flight: a tick is a few awaited file writes, and one that outlives
   * the test would write into the task directory while the afterEach cleanup removes it (ENOTEMPTY).
   */
  const poll = (fn: () => Promise<void>) => {
    const inflight = new Set<Promise<void>>();
    const timer = setInterval(() => {
      const tick = fn().catch(() => {});
      inflight.add(tick);
      void tick.finally(() => inflight.delete(tick));
    }, 40);
    return async () => {
      clearInterval(timer);
      await Promise.all([...inflight]);
    };
  };

  /** Steer `times` times, each once a fresh Developer attempt has started and the last steer is gone. */
  const steerDeveloper = (times: number) => {
    let sent = 0;
    return poll(async () => {
      if (sent >= times || existsSync(taskSteerRequestPath(projectDir, "t1"))) return;
      if (devHeaders(await liveLog()) !== sent + 1) return;
      sent++;
      await requestSteer(sent === 1 ? STEER_TEXT : `${STEER_TEXT} ${sent}`);
    });
  };

  const runTask = async (prompt: string) => {
    await store.create(newTask(fm(), prompt));
    const r = await engine.tick();
    if (r.kind !== "ran") throw new Error(`expected ran, got ${r.kind}`);
    return r.outcome;
  };

  it("kills the running step, resumes its session with the new prompt and finishes", async () => {
    const stop = steerDeveloper(1);
    let outcome;
    try {
      outcome = await runTask("Build it. [[mock-stall developer=1]]");
    } finally {
      await stop();
    }
    expect(outcome.kind).toBe("done");
    expect(devCalls()).toBe(2);
    expect(mockState.resumes).toHaveLength(1);
    const resumed = mockState.resumes[0]!;
    expect(resumed.role).toBe("developer");
    expect(resumed.sessionId).toMatch(/^mock-session-\d+$/);
    expect(resumed.prompt).toBe(
      "The user sent new instructions while you were working. Continue the same task from where " +
        `you stopped and apply them:\n\n${STEER_TEXT}`,
    );
    const done = (await store.get("t1"))!;
    expect(done.body.log).toContain(`### Steered\n${STEER_TEXT}`);
    expect(done.body.log).toContain("### Developer (steer 1)");
    // The interrupted attempt is counted: planner, refinement, developer x2 and reviewer.
    expect(done.frontmatter.tokens?.costUsd).toBeCloseTo(0.05);
    // The control request is consumed and the durable entry records mode and application.
    expect(await exists(taskSteerRequestPath(projectDir, "t1"))).toBe(false);
    const [entry] = parseInjected(done.body.injected);
    expect(entry?.mode).toBe("now");
    expect(entry?.appliedAt).toBeTruthy();
  });

  it("keeps the steered attempt's usage on the task when the step then fails", async () => {
    mockState.onRun = async (opts) => {
      if (opts.role === "developer" && opts.resumeSessionId) throw new Error("developer crashed");
    };
    const stop = steerDeveloper(1);
    let outcome;
    try {
      outcome = await runTask("Build it. [[mock-stall developer=1]]");
    } finally {
      await stop();
    }
    expect(outcome.kind).toBe("failed");
    // Planner, refinement and the steered developer attempt; the crashed one reported nothing.
    expect((await store.get("t1"))!.frontmatter.tokens?.costUsd).toBeCloseTo(0.03);
  });

  it("a tool that cannot resume restarts the step with its prompt, the new text and the interruption note", async () => {
    mockState.resumeSupported = false;
    const stop = steerDeveloper(1);
    try {
      const outcome = await runTask("Build it. [[mock-stall developer=1]]");
      expect(outcome.kind).toBe("done");
    } finally {
      await stop();
    }
    expect(mockState.resumes).toHaveLength(0);
    const devPrompts = mockState.prompts.filter((_, i) => mockState.calls[i] === "developer");
    expect(devPrompts).toHaveLength(2);
    expect(devPrompts[1]).toContain("Build it.");
    expect(devPrompts[1]).toContain("## Plan");
    expect(devPrompts[1]).toContain(STEER_TEXT);
    expect(devPrompts[1]).toContain("## Previous attempt interrupted");
    expect(devPrompts[1]).toContain("git status");
    expect(devPrompts[0]).not.toContain("## Previous attempt interrupted");
  });

  it("steers do not use the transient retry budget", async () => {
    await engine.settingsStore.update({ retries: { transient: 0 } });
    mockState.resumeSupported = false;
    const stop = steerDeveloper(2);
    try {
      const outcome = await runTask("Build it. [[mock-stall developer=2]]");
      expect(outcome.kind).toBe("done");
    } finally {
      await stop();
    }
    expect(devCalls()).toBe(3);
  });

  it("stops steering one step after the cap; later prompts wait for the next step", async () => {
    mockState.resumeSupported = false;
    // The 6th run stalls with no steer path and is cut by the idle watchdog, then retried.
    await engine.settingsStore.update({
      retries: { transient: 2, backoffMs: [0], idleTimeoutMs: 5000 },
    });
    const stop = steerDeveloper(6);
    let outcome;
    try {
      outcome = await runTask("Build it. [[mock-stall developer=6]]");
    } finally {
      await stop();
    }
    expect(outcome.kind === "failed" ? outcome.error : outcome.kind).toBe("done");
    const done = (await store.get("t1"))!;
    expect(done.body.log).toContain("Steer limit reached for Developer (5)");
    expect(done.body.log).toContain("### Developer (steer 5)");
    expect(done.body.log).not.toContain("### Developer (steer 6)");
    // 5 steered runs, the stalled sixth, its transient retry.
    expect(devCalls()).toBe(7);
  }, 60000);

  it("a steer that arrives between steps applies to the next step without a kill", async () => {
    let first = true;
    mockState.onRun = async (opts) => {
      if (opts.role === "planner" && first) {
        first = false;
        await requestSteer(STEER_TEXT);
      }
    };
    const outcome = await runTask("Build it.");
    expect(outcome.kind).toBe("done");
    expect(mockState.calls).toEqual(["planner", "planner", "developer", "reviewer"]);
    expect(mockState.resumes).toHaveLength(0);
    const refine = mockState.prompts[1]!;
    expect(refine).toContain(STEER_TEXT);
    // Injected once: the prompt already carried it from prompts.md.
    expect(refine.split(STEER_TEXT)).toHaveLength(2);
    const done = (await store.get("t1"))!;
    expect(done.body.log).toContain(`### Steered\n${STEER_TEXT}`);
    expect(await exists(taskSteerRequestPath(projectDir, "t1"))).toBe(false);
    expect(parseInjected(done.body.injected)[0]?.appliedAt).toBeTruthy();
  });

  it("drops a now-steer model taken between steps while keeping its text", async () => {
    const seen: string[] = [];
    let first = true;
    const mock = engine.registry.get("mock")!;
    for (const id of ["claude-code", "codex", "opencode"]) {
      engine.registry.register({
        id,
        displayName: id,
        defaultModels: ["test-model"],
        installed: () => mock.installed(),
        detect: () => mock.detect(),
        listModels: () => mock.listModels(),
        run: async (opts) => {
          seen.push(`${opts.role}:${opts.model}`);
          return mock.run(opts);
        },
      });
    }
    mockState.onRun = async (opts) => {
      if (opts.role === "developer" && first) {
        first = false;
        await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
        await appendFile(
          taskSteerRequestPath(projectDir, "t1"),
          JSON.stringify({ at: new Date().toISOString(), text: "keep this text", model: "opus" }) +
            "\n",
        );
      }
    };
    await store.create(
      newTask(
        fm({
          tools: {
            planner: { tool: "mock", model: "mock-default" },
            developer: { tool: "claude-code", model: "sonnet" },
            reviewer: { tool: "codex", model: "gpt-5-codex" },
            observer: { tool: "opencode", model: "test-model" },
          },
        }),
        "Build it.",
      ),
    );
    const result = await engine.tick();
    if (result.kind !== "ran") throw new Error(`expected ran, got ${result.kind}`);
    expect(result.outcome.kind).toBe("done");
    expect(seen.find((s) => s.startsWith("reviewer:"))).toBe("reviewer:gpt-5-codex");
    const done = (await store.get("t1"))!;
    expect(done.body.log).toContain("keep this text");
    expect(done.body.log).toContain(
      "Dropped model switch from a steer that arrived after its step ended",
    );
  });

  it("a stop request wins over a steer", async () => {
    let sent = false;
    const stop = poll(async () => {
      if (sent || devHeaders(await liveLog()) !== 1) return;
      sent = true;
      await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
      await writeFile(taskStopRequestPath(projectDir, "t1"), "stop\n");
      await requestSteer(STEER_TEXT);
    });
    try {
      const outcome = await runTask("Build it. [[mock-stall developer=1]]");
      expect(outcome.kind).toBe("stopped");
    } finally {
      await stop();
    }
    expect(devCalls()).toBe(1);
  });

  it("in-place steering logs the steer and marks the injection applied", async () => {
    const originalTool = engine.registry.get("mock")!;
    const tool = {
      id: originalTool.id,
      displayName: originalTool.displayName,
      defaultModels: originalTool.defaultModels,
      installed: () => originalTool.installed(),
      detect: (...args: any[]) => originalTool.detect(...args),
      listModels: () => originalTool.listModels(),
      run: (opts: RunOptions) => originalTool.run(opts),
      supportsResume: true,
      steersInPlace: true,
    };
    engine.registry.register(tool);
    let steered = false;
    const seen: RunOptions[] = [];
    mockState.onRun = async (opts) => {
      if (opts.role !== "developer") return;
      seen.push(opts);
      if (!steered) {
        steered = true;
        await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
        await store.appendInjected("t1", "keep going", "user", "now");
        await writeFile(
          taskSteerRequestPath(projectDir, "t1"),
          JSON.stringify({ text: "keep going" }) + "\n",
        );
        const req = await opts.onSteer?.();
        expect(req?.texts).toEqual(["keep going"]);
        expect(req?.last).toBe(false);
      }
    };
    try {
      await store.create(newTask(fm(), "Build it."));
      const running = await store.transition("t1", "running");
      const pipeline = new Pipeline({
        root: projectDir,
        store,
        registry: engine.registry,
        settings: effectiveSettings(await engine.settingsStore.load(), project),
      });
      const outcome = await pipeline.run(running);
      expect(outcome.kind).toBe("done");
      expect(seen).toHaveLength(1);
      const done = await store.get("t1");
      expect(done?.body.log).toContain("### Steered (in place)\nkeep going");
      expect(done?.body.injected).toContain("keep going");
    } finally {
      engine.registry.register(originalTool);
    }
  });

  it("passes the cumulative interrupted cost as the resumed session baseline", async () => {
    const originalTool = engine.registry.get("mock")!;
    const tool = {
      id: originalTool.id,
      displayName: originalTool.displayName,
      defaultModels: originalTool.defaultModels,
      installed: () => originalTool.installed(),
      detect: (...args: any[]) => originalTool.detect(...args),
      listModels: () => originalTool.listModels(),
      run: async (opts: RunOptions) => {
        if (opts.role === "developer") {
          seen.push(opts);
          if (first) {
            first = false;
            await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
            await writeFile(
              taskSteerRequestPath(projectDir, "t1"),
              JSON.stringify({ text: "resume" }) + "\n",
            );
            throw new ToolRunError("mock", 1, false, false, "", "", false, 0, {
              steered: true,
              sessionId: "same-session",
              usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.4, known: true },
            });
          }
          return {
            output: "",
            report: "# Developer",
            sessionId: opts.resumeSessionId,
            usage: { inputTokens: 20, outputTokens: 8, costUsd: 0.6, known: true },
          };
        }
        return originalTool.run(opts);
      },
      supportsResume: true,
    };
    engine.registry.register(tool);
    let first = true;
    const seen: RunOptions[] = [];
    try {
      await store.create(newTask(fm(), "Build it. [[mock-cost 0]]"));
      const running = await store.transition("t1", "running");
      const pipeline = new Pipeline({
        root: projectDir,
        store,
        registry: engine.registry,
        settings: effectiveSettings(await engine.settingsStore.load(), project),
      });
      expect((await pipeline.run(running)).kind).toBe("done");
      expect(seen[1]?.resumeSessionId).toBe("same-session");
      expect(seen[1]?.resumeBaseline).toEqual({
        inputTokens: 10,
        outputTokens: 4,
        costUsd: 0.4,
        known: true,
      });
      expect((await store.get("t1"))?.frontmatter.tokens?.costUsd).toBeCloseTo(1.0);
    } finally {
      engine.registry.register(originalTool);
    }
  });

  it("applies a fallback steer model to the rerun attempt", async () => {
    const originalTool = engine.registry.get("mock")!;
    const tool = {
      id: originalTool.id,
      displayName: originalTool.displayName,
      defaultModels: originalTool.defaultModels,
      installed: () => originalTool.installed(),
      detect: (...args: any[]) => originalTool.detect(...args),
      listModels: () => originalTool.listModels(),
      run: (opts: RunOptions) => originalTool.run(opts),
      supportsResume: false,
    };
    engine.registry.register(tool);
    let first = true;
    const models: string[] = [];
    mockState.onRun = async (opts) => {
      if (opts.role !== "developer") return;
      models.push(opts.model);
      if (first) {
        first = false;
        await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
        await writeFile(
          taskSteerRequestPath(projectDir, "t1"),
          JSON.stringify({ text: "switch", model: "opus" }) + "\n",
        );
        throw new ToolRunError("mock", 1, false, false, "", "", false, 0, { steered: true });
      }
    };
    try {
      await store.create(newTask(fm(), "Build it. [[mock-cost 0]]"));
      const running = await store.transition("t1", "running");
      const pipeline = new Pipeline({
        root: projectDir,
        store,
        registry: engine.registry,
        settings: effectiveSettings(await engine.settingsStore.load(), project),
      });
      expect((await pipeline.run(running)).kind).toBe("done");
      expect(models).toEqual(["mock-default", "opus"]);
    } finally {
      engine.registry.register(originalTool);
    }
  });
});
