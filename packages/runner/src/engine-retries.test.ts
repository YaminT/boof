import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  newTask,
  EpicStore,
  ProjectStore,
  TaskStore,
  taskControlDir,
  taskStopRequestPath,
  workingAreaDir,
  type TaskFrontmatter,
} from "@boof/heart";
import { RunnerEngine } from "./engine.js";
import { NON_INTERACTIVE, SANDBOX_DEVELOPER_LIMITS, SYSTEM_PROMPTS } from "./pipeline.js";
import { mockState, resetMock } from "./tools/mock.js";
import { useEngineRig, exists, wtPath, writeIn, fm } from "./engine-test-support.js";

let dataRoot: string;
let engine: RunnerEngine;
let projectDir: string;
let store: TaskStore;

useEngineRig((rig) => {
  ({ dataRoot, engine, projectDir, store } = rig);
});

describe("transient retries, stalls and prompts (mock tool)", () => {
  const MOCK = { tool: "mock", model: "mock-default" };
  const configure = async (over: {
    retries?: { transient?: number; backoffMs?: number[]; idleTimeoutMs?: number };
    observer?: boolean;
  }) => {
    const s = await engine.settingsStore.load();
    await engine.settingsStore.save({
      ...s,
      roles: { ...s.roles, ...(over.observer ? { observer: MOCK } : {}) },
      ...(over.retries
        ? {
            retries: {
              transient: 2,
              backoffMs: [0],
              idleTimeoutMs: 1200000,
              poolWaitMs: 1800000,
              ...over.retries,
            },
          }
        : {}),
    });
  };
  const run = async (prompt: string, over: Partial<TaskFrontmatter> = {}) => {
    await store.create(newTask(fm(over), prompt));
    const r = await engine.tick();
    if (r.kind !== "ran") throw new Error(`expected ran, got ${r.kind}`);
    return r.outcome;
  };
  const devCalls = () => mockState.calls.filter((c) => c === "developer").length;

  it("every prompt of a task in a project with a brief carries ## Project, and none without", async () => {
    await new ProjectStore(dataRoot).update("default", { brief: "A shop for hats.\nStack: Hono." });
    await run("Add a cart");
    expect(mockState.prompts.length).toBeGreaterThan(0);
    for (const p of mockState.prompts) {
      expect(p).toContain("## Project\nA shop for hats.\nStack: Hono.");
      expect(p.indexOf("## Project")).toBeLessThan(p.indexOf("## Prompt"));
    }
    resetMock();
    await new ProjectStore(dataRoot).update("default", { brief: null });
    await run("Add a hat", { id: "t2" });
    expect(mockState.prompts.length).toBeGreaterThan(0);
    for (const p of mockState.prompts) expect(p).not.toContain("## Project");
  });

  it("passes runner.inheritMcpServers to every tool run (off unless switched on)", async () => {
    const seen: (boolean | undefined)[] = [];
    mockState.onRun = async (opts) => {
      seen.push(opts.inheritMcpServers);
    };
    await run("First");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === false)).toBe(true);
    seen.length = 0;
    const s = await engine.settingsStore.load();
    await engine.settingsStore.save({ ...s, runner: { ...s.runner, inheritMcpServers: true } });
    await run("Second", { id: "t2" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === true)).toBe(true);
  });

  it("passes runner.agentEnv to every tool run", async () => {
    const seen: (readonly string[] | undefined)[] = [];
    mockState.onRun = async (opts) => {
      seen.push(opts.agentEnv);
    };
    const s = await engine.settingsStore.load();
    await engine.settingsStore.save({ ...s, runner: { ...s.runner, agentEnv: ["MY_TOKEN"] } });
    await run("With env");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v?.join() === "MY_TOKEN")).toBe(true);
  });

  it("puts ## Hierarchy after ## Project and before ## Prompt", async () => {
    await new ProjectStore(dataRoot).update("default", { brief: "A shop for hats." });
    await store.create(newTask(fm({ id: "p", status: "draft", title: "Parent" }), "parent"));
    await store.transition("p", "pending");
    await store.transition("p", "running");
    await store.transition("p", "done");
    await run("Add a cart", { id: "c", parentId: "p" });
    expect(mockState.prompts.length).toBeGreaterThan(0);
    for (const p of mockState.prompts) {
      expect(p.indexOf("## Project")).toBeGreaterThanOrEqual(0);
      expect(p.indexOf("## Project")).toBeLessThan(p.indexOf("## Hierarchy"));
      expect(p.indexOf("## Hierarchy")).toBeLessThan(p.indexOf("## Prompt"));
      expect(p).toContain('subtask of `p` "Parent" (done)');
    }
  });

  it("epic priority does not change which task runs first", async () => {
    const epics = new EpicStore(new ProjectStore(dataRoot).dir("default"));
    await epics.create({ title: "Low", priority: 0 });
    await epics.create({ title: "High", priority: 100 });
    await store.create(newTask(fm({ id: "older", epicId: "low" }), "older"));
    await new Promise((r) => setTimeout(r, 15));
    await store.create(newTask(fm({ id: "newer", epicId: "high" }), "newer"));
    const r = await engine.tick();
    if (r.kind !== "ran") throw new Error(`expected ran, got ${r.kind}`);
    expect((await store.get("older"))!.frontmatter.status).toBe("done");
    expect((await store.get("newer"))!.frontmatter.status).toBe("pending");
  });

  it("one transient failure, then success: done, same worktree, retry logged, prompt amended", async () => {
    await configure({ retries: {} });
    const cwds: string[] = [];
    mockState.onRun = async (opts) => {
      if (opts.role === "developer") cwds.push(opts.cwd);
    };
    const outcome = await run("Build it. [[mock-transient developer=1]]");
    expect(outcome.kind).toBe("done");
    expect(devCalls()).toBe(2);
    expect(cwds).toEqual([wtPath(), wtPath()]);
    const devPrompts = mockState.prompts.filter((_, i) => mockState.calls[i] === "developer");
    expect(devPrompts[0]).not.toContain("## Previous attempt interrupted");
    expect(devPrompts[1]).toContain("## Previous attempt interrupted");
    expect(devPrompts[1]).toContain("git status");
    const done = await store.get("t1");
    expect(done?.body.log).toMatch(
      /Transient failure in Developer \(attempt 1\/2\): API Error: 503.*retrying in 0s in the same worktree/,
    );
  });

  it("retries exhausted: the task fails and the worktree is kept", async () => {
    await configure({ retries: { transient: 2 } });
    mockState.onRun = async (opts) => {
      if (opts.role === "planner") await writeIn(opts, "wip.txt");
    };
    const outcome = await run("Build it. [[mock-transient developer=3]]");
    expect(outcome.kind).toBe("failed");
    expect(devCalls()).toBe(3);
    expect(await exists(join(wtPath(), "wip.txt"))).toBe(true);
  });

  it("transient: 0 disables retries", async () => {
    await configure({ retries: { transient: 0 } });
    const outcome = await run("Build it. [[mock-transient developer=1]]");
    expect(outcome.kind).toBe("failed");
    expect(devCalls()).toBe(1);
  });

  it("a non-transient error is not retried", async () => {
    await configure({ retries: {} });
    mockState.failRole = "developer";
    const outcome = await run("Build it.");
    expect(outcome.kind).toBe("failed");
    expect(devCalls()).toBe(1);
  });

  it("a stop request during the backoff stops the task", async () => {
    await configure({ retries: { backoffMs: [60000] } });
    const poll = setInterval(() => {
      void readFile(join(workingAreaDir(projectDir, "t1"), "log.txt"), "utf8")
        .then(async (log) => {
          if (!log.includes("Transient failure")) return;
          await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
          await writeFile(taskStopRequestPath(projectDir, "t1"), "stop\n");
        })
        .catch(() => {});
    }, 50);
    const started = Date.now();
    try {
      const outcome = await run("Build it. [[mock-transient developer=1]]");
      expect(outcome.kind).toBe("stopped");
    } finally {
      clearInterval(poll);
    }
    // Backoff is 60s, polled every 250ms. 45s still fails that wait and covers a slow run.
    expect(Date.now() - started).toBeLessThan(45_000);
    expect(devCalls()).toBe(1);
    expect(await exists(wtPath())).toBe(true);
  }, 120_000);

  it("a stalled tool is killed and retried as a transient failure", async () => {
    await configure({ retries: { idleTimeoutMs: 300 } });
    const outcome = await run("Build it. [[mock-stall developer=1]]");
    expect(outcome.kind).toBe("done");
    expect(devCalls()).toBe(2);
    expect((await store.get("t1"))?.body.log).toContain("stalled: no output");
  });

  it("every role's system prompt carries the non-interactive guard", async () => {
    await configure({ observer: true });
    mockState.roleQuestions = { developer: ["Which db?"] };
    const outcome = await run(
      "Build it. [[mock-verdicts observer=CHANGES_REQUESTED,APPROVE reviewer=APPROVE]]",
    );
    expect(outcome.kind).toBe("done");
    const seen = new Map<string, Set<string>>();
    for (const { role, systemPrompt } of mockState.systemPrompts) {
      expect(systemPrompt).toContain(NON_INTERACTIVE);
      expect(systemPrompt).toContain("Never end your turn while waiting on background");
      const set = seen.get(role) ?? new Set<string>();
      set.add(systemPrompt);
      seen.set(role, set);
    }
    const all = [...seen.values()].flatMap((v) => [...v]);
    const has = (needle: string) => all.some((p) => p.includes(needle));
    expect(has("You are the PLANNER. Produce")).toBe(true);
    expect(has("PLANNER doing a refinement")).toBe(true);
    expect(has("You are the DEVELOPER. Implement")).toBe(true);
    expect(has("DEVELOPER fixing review findings")).toBe(true);
    expect(has("You are the OBSERVER")).toBe(true);
    expect(has("You are the REVIEWER")).toBe(true);
    expect(has("Answer the following questions")).toBe(true);
    expect(has(SANDBOX_DEVELOPER_LIMITS)).toBe(false);
    for (const p of Object.values(SYSTEM_PROMPTS)) expect(p).toContain(NON_INTERACTIVE);
    expect(NON_INTERACTIVE).toContain(
      'd=$(mktemp -d); (cmd; echo $? > "$d/done") > "$d/log" 2>&1 &',
    );
    expect(NON_INTERACTIVE).toContain('until [ -f "$d/done" ]');
    expect(NON_INTERACTIVE).not.toContain("/tmp/x.done");
    expect(NON_INTERACTIVE).not.toContain("/tmp/x.log");
  });

  it("a role's questions are answered by the planner and the role runs again with the answers", async () => {
    await configure({ observer: true });
    mockState.roleQuestions = { developer: ["Which db?"], reviewer: ["Which schema?"] };
    const from = mockState.prompts.length;
    const outcome = await run("Build it. [[mock-verdicts observer=APPROVE reviewer=APPROVE]]");
    expect(outcome.kind).toBe("done");
    const prompts = mockState.prompts.slice(from);
    const withAnswers = prompts.filter((p) =>
      p.includes("## Answers from the planner to your questions"),
    );
    // The developer and the reviewer each ran again with their answers.
    expect(withAnswers.length).toBeGreaterThanOrEqual(2);
    expect(withAnswers.some((p) => p.includes("## Diff under review"))).toBe(true);
    const task = await store.get("t1");
    expect(task?.body.questions).toContain("### developer asked");
    expect(task?.body.questions).toContain("Which db?");
    expect(task?.body.questions).toContain("### reviewer asked");
    expect(task?.body.questions).toContain("### planner answered");
  });

  it("when the planner cannot answer a role's question the task parks, and the role gets the owner's answer on resume", async () => {
    mockState.roleQuestions = { developer: ["Which db?"] };
    mockState.answerQuestions = ["Is Postgres allowed?"];
    const first = await run("Build it.");
    expect(first.kind).toBe("parked");
    const parked = (await store.get("t1"))!;
    expect(parked.frontmatter.status).toBe("action");
    expect(parked.frontmatter.questions).toBe("pending");
    expect(parked.body.questions).toContain("(for the developer) Is Postgres allowed?");
    await store.transition("t1", "pending", (t) => {
      t.body.answers = "Yes, Postgres is fine.";
      t.frontmatter.questions = "answered";
    });
    const from = mockState.prompts.length;
    const second = await engine.tick();
    expect(second.kind === "ran" ? second.outcome.kind : second.kind).toBe("done");
    const devPrompts = mockState.prompts.slice(from).filter((p) => p.includes("## Plan"));
    expect(devPrompts.some((p) => p.includes("Yes, Postgres is fine."))).toBe(true);
  });

  it("carried findings survive iteration 2 parking and resuming", async () => {
    await configure({ observer: true });
    await run("Twice. [[mock-verdicts observer=APPROVE reviewer=APPROVE]]", { runs: 2 });
    mockState.plannerQuestions = ["Which db?"];
    const parked = await engine.tick();
    if (parked.kind === "ran") expect(parked.outcome.kind).toBe("parked");
    await store.transition("t1", "pending", (t) => {
      t.body.answers = "Postgres.";
      t.frontmatter.questions = "answered";
    });
    const from = mockState.prompts.length;
    await engine.tick();
    const resumed = mockState.prompts.slice(from);
    expect(resumed.length).toBeGreaterThan(0);
    for (const p of resumed) {
      expect(p).toContain("## Findings from the previous iteration");
      expect(p).toContain("### Reviewer (final report)");
    }
  });

  it("carried findings survive iteration 2 failing and being retried", async () => {
    await configure({ observer: true });
    await run("Twice. [[mock-verdicts observer=APPROVE reviewer=APPROVE]]", { runs: 2 });
    mockState.failRole = "developer";
    const failed = await engine.tick();
    if (failed.kind === "ran") expect(failed.outcome.kind).toBe("failed");
    mockState.failRole = null;
    await store.transition("t1", "pending");
    const from = mockState.prompts.length;
    await engine.tick();
    const retried = mockState.prompts.slice(from);
    expect(retried.length).toBeGreaterThan(0);
    for (const p of retried) {
      expect(p).toContain("## Findings from the previous iteration");
      expect(p).toContain("### Reviewer (final report)");
    }
  });

  it(
    "carried findings stay iteration 1's when iteration 2 fails after its observer round 1",
    async () => {
      await configure({ observer: true });
      await run("Twice. [[mock-verdicts observer=CHANGES_REQUESTED,APPROVE reviewer=APPROVE]]", {
        runs: 2,
      });
      let failFix = true;
      mockState.onRun = async (opts) => {
        const observerCalls = mockState.calls.filter((c) => c === "observer").length;
        if (failFix && opts.role === "developer" && observerCalls >= 3) {
          throw new Error("boom after observer round 1 of iteration 2");
        }
      };
      const failed = await engine.tick();
      if (failed.kind === "ran") expect(failed.outcome.kind).toBe("failed");
      failFix = false;
      await store.transition("t1", "pending");
      const from = mockState.prompts.length;
      await engine.tick();
      const retried = mockState.prompts.slice(from);
      expect(retried.length).toBeGreaterThan(0);
      for (const p of retried) {
        expect(p).toContain("## Findings from the previous iteration");
        expect(p).toContain("#### Round 2 — APPROVE");
        expect(p).not.toContain("#### Round 1 — CHANGES_REQUESTED");
      }
    },
    process.platform === "win32" ? 180_000 : 20_000,
  );

  it("runs > 1: iteration 2 prompts carry iteration 1's final observer and reviewer reports", async () => {
    await configure({ observer: true });
    await run("Twice. [[mock-verdicts observer=CHANGES_REQUESTED,APPROVE reviewer=APPROVE]]", {
      runs: 2,
    });
    await engine.tick();
    const heading = "## Findings from the previous iteration";
    const iter2 = mockState.prompts.filter((p) => p.includes("## Iteration 2 of 2"));
    const iter1 = mockState.prompts.filter((p) => !p.includes("## Iteration 2 of 2"));
    expect(iter1.length).toBeGreaterThan(0);
    expect(iter2.length).toBeGreaterThan(0);
    for (const p of iter1) expect(p).not.toContain(heading);
    for (const p of iter2) {
      const from = p.indexOf(heading);
      const next = p.indexOf("\n\n## ", from + heading.length);
      const section = p.slice(from, next === -1 ? undefined : next);
      expect(p).toContain(heading);
      expect(section).toContain("### Observer (final report)");
      expect(section).toContain("### Reviewer (final report)");
      expect(section).toContain("#### Round 2 — APPROVE");
      expect(section).toContain("VERDICT: APPROVE");
      // Only the final round, not the earlier CHANGES_REQUESTED one.
      expect(section).not.toContain("mock issue observer round 1");
    }
  }, 60_000);
});
