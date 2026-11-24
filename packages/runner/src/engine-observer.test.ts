import { describe, expect, it } from "vitest";
import { newTask, TaskStore, taskFilePath, type TaskFrontmatter } from "@boof/heart";
import { RunnerEngine } from "./engine.js";
import { SYSTEM_PROMPTS } from "./pipeline.js";
import { mockState } from "./tools/mock.js";
import {
  useEngineRig,
  exists,
  wtPath,
  gitOut,
  writeIn,
  commitIn,
  fm,
} from "./engine-test-support.js";

let engine: RunnerEngine;
let projectDir: string;
let store: TaskStore;

useEngineRig((rig) => {
  ({ engine, projectDir, store } = rig);
});

describe("observer, verdict gate and fix loop (mock tool)", () => {
  const MOCK = { tool: "mock", model: "mock-default" };
  const withObserver = async (review?: {
    gate?: boolean;
    maxFixRounds?: number;
    maxInlineDiffBytes?: number;
  }) => {
    const s = await engine.settingsStore.load();
    await engine.settingsStore.save({
      ...s,
      roles: { ...s.roles, observer: MOCK },
      ...(review
        ? { review: { gate: true, maxFixRounds: 2, maxInlineDiffBytes: 120000, ...review } }
        : {}),
    });
  };
  const runTask = async (prompt: string, over: Partial<TaskFrontmatter> = {}) => {
    await store.create(newTask(fm(over), prompt));
    const r = await engine.tick();
    if (r.kind !== "ran") throw new Error(`expected ran, got ${r.kind}`);
    return r.outcome;
  };
  const count = (role: string) => mockState.calls.filter((c) => c === role).length;
  const branchKept = async () =>
    (await gitOut(["rev-parse", "--verify", "refs/heads/boof-runner/t1"])).code === 0;

  it("observer absent: no observer call, task done", async () => {
    const out = await runTask("x");
    expect(out.kind).toBe("done");
    expect(mockState.calls).not.toContain("observer");
    expect(count("reviewer")).toBe(1);
  });

  it("observer present: runs after the developer, report recorded with round", async () => {
    await withObserver();
    const out = await runTask("x");
    expect(out.kind).toBe("done");
    expect(mockState.calls).toEqual(["planner", "planner", "developer", "observer", "reviewer"]);
    const done = await store.get("t1");
    expect(done?.body.reports.observer).toContain("Round 1 — APPROVE");
    expect(done?.body.reports.reviewer).toContain("Round 1 — APPROVE");
    expect(done?.body.log).toContain("Observer verdict (round 1): APPROVE");
    expect(done?.body.log).toContain("Reviewer verdict (round 1): APPROVE");
  });

  it("observer CHANGES_REQUESTED then APPROVE: developer runs twice, task done", async () => {
    await withObserver();
    const out = await runTask("x [[mock-verdicts observer=CHANGES_REQUESTED,APPROVE]]");
    expect(out.kind).toBe("done");
    expect(count("developer")).toBe(2);
    expect(count("observer")).toBe(2);
    expect(mockState.prompts.some((p) => p.includes("mock issue observer round 1"))).toBe(true);
    const dev2 = mockState.prompts.filter((p) => p.includes("## Findings (observer round 1)"));
    expect(dev2).toHaveLength(1);
    expect(dev2[0]).toContain("mock issue observer round 1");
    expect(dev2[0]).toContain("rebut it with evidence");
    expect(dev2[0]).toContain("## Plan");
    const done = await store.get("t1");
    expect(done?.body.reports.observer).toContain("Round 1 — CHANGES_REQUESTED");
    expect(done?.body.reports.observer).toContain("Round 2 — APPROVE");
    expect(done?.body.reports.developer).toContain("Fix round 1 (observer)");
  });

  it("reviewer CHANGES_REQUESTED then APPROVE: fix and re-review, task done", async () => {
    const out = await runTask("x [[mock-verdicts reviewer=CHANGES_REQUESTED,APPROVE]]");
    expect(out.kind).toBe("done");
    expect(count("developer")).toBe(2);
    expect(count("reviewer")).toBe(2);
    expect(mockState.prompts.some((p) => p.includes("## Findings (reviewer round 1)"))).toBe(true);
  });

  it("reviewer fix is re-checked by the observer before the reviewer re-checks", async () => {
    await withObserver();
    const out = await runTask("x [[mock-verdicts reviewer=CHANGES_REQUESTED,APPROVE]]");
    expect(out.kind).toBe("done");
    expect(mockState.calls.slice(2)).toEqual([
      "developer",
      "observer",
      "reviewer",
      "developer",
      "observer",
      "reviewer",
    ]);
  });

  it("budget exhausted: fails, keeps worktree and branch", async () => {
    await withObserver({ maxFixRounds: 1 });
    const out = await runTask("x [[mock-verdicts observer=CHANGES_REQUESTED]]");
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.error).toBe("review not approved: observer CHANGES_REQUESTED");
    }
    expect(count("developer")).toBe(2);
    expect(count("reviewer")).toBe(0);
    expect(await exists(wtPath())).toBe(true);
    expect(await branchKept()).toBe(true);
    expect(await exists(taskFilePath(projectDir, "failed", "t1"))).toBe(true);
  });

  it("reviewer budget exhausted: fails with reviewer reason", async () => {
    await engine.settingsStore.update({
      review: { gate: true, maxFixRounds: 1, maxInlineDiffBytes: 120000 },
    });
    const out = await runTask("x [[mock-verdicts reviewer=CHANGES_REQUESTED]]");
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.error).toBe("review not approved: reviewer CHANGES_REQUESTED");
    }
    expect(count("reviewer")).toBe(2);
    expect(await exists(wtPath())).toBe(true);
    expect(await branchKept()).toBe(true);
  });

  it("maxFixRounds 0: first CHANGES_REQUESTED fails without a fix round", async () => {
    await engine.settingsStore.update({
      review: { gate: true, maxFixRounds: 0, maxInlineDiffBytes: 120000 },
    });
    const out = await runTask("x [[mock-verdicts reviewer=CHANGES_REQUESTED]]");
    expect(out.kind).toBe("failed");
    expect(count("developer")).toBe(1);
  });

  it("REJECT from the reviewer fails the task without a fix round", async () => {
    const out = await runTask("x [[mock-verdicts reviewer=REJECT]]");
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toBe("review not approved: reviewer REJECT");
    expect(count("developer")).toBe(1);
    expect(await branchKept()).toBe(true);
  });

  it("REJECT from the observer fails before the reviewer runs", async () => {
    await withObserver();
    const out = await runTask("x [[mock-verdicts observer=REJECT]]");
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toBe("review not approved: observer REJECT");
    expect(count("reviewer")).toBe(0);
  });

  it.each(["NONE", "GARBLED", "CONFLICT"])("%s verdict is not approved", async (token) => {
    const out = await runTask(`x [[mock-verdicts reviewer=${token}]]`);
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toBe("review not approved: reviewer INVALID");
    expect(count("developer")).toBe(1);
    expect(await exists(wtPath())).toBe(true);
    expect(await branchKept()).toBe(true);
  });

  it.each(["NONE", "GARBLED", "CONFLICT"])("observer %s verdict is not approved", async (token) => {
    await withObserver();
    const out = await runTask(`x [[mock-verdicts observer=${token}]]`);
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toBe("review not approved: observer INVALID");
    expect(count("reviewer")).toBe(0);
  });

  it(
    "labels each findings block with its source round and role",
    async () => {
      await withObserver({ maxFixRounds: 3 });
      const out = await runTask(
        "x [[mock-verdicts observer=CHANGES_REQUESTED,APPROVE,CHANGES_REQUESTED,APPROVE reviewer=CHANGES_REQUESTED,APPROVE]]",
      );
      expect(out.kind).toBe("done");
      const findings = mockState.prompts.filter((p) => p.includes("## Findings ("));
      expect(
        findings.some(
          (p) =>
            p.includes("## Findings (observer round 3)") &&
            p.includes("- finding: mock issue observer round 3"),
        ),
      ).toBe(true);
      expect(findings.some((p) => p.includes("## Findings (observer round 2)"))).toBe(false);
      expect(findings.some((p) => p.includes("## Findings (reviewer round 1)"))).toBe(true);
    },
    process.platform === "win32" ? 180_000 : 20_000,
  );

  it.each(["observer", "reviewer"] as const)(
    "%s system prompt keeps the worktree clean",
    async (role) => {
      expect(SYSTEM_PROMPTS[role]).toContain("temporary directory outside the working directory");
      expect(SYSTEM_PROMPTS[role]).toContain("Leave the working tree exactly as you found it");

      await withObserver();
      const seen: Record<string, string> = {};
      mockState.onRun = async (opts) => {
        seen[opts.role] = opts.systemPrompt;
      };
      const out = await runTask("x");
      expect(out.kind).toBe("done");
      expect(seen[role]).toContain("Leave the working tree exactly as you found it");
    },
  );

  it("unknown mock verdict token fails the task", async () => {
    const out = await runTask("x [[mock-verdicts reviewer=BOGUS]]");
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toContain("unknown mock verdict token: BOGUS");
  });

  it(
    "scripted verdict rounds restart each iteration (runs: 2)",
    async () => {
      await runTask("x [[mock-verdicts reviewer=CHANGES_REQUESTED,APPROVE]]", { runs: 2 });
      const second = await engine.tick();
      expect(second.kind).toBe("ran");
      const end = await store.get("t1");
      expect(end?.frontmatter.status).toBe("done");
      expect(count("developer")).toBe(4);
      expect(count("reviewer")).toBe(4);
    },
    process.platform === "win32" ? 180_000 : 20_000,
  );

  it("gate false: verdicts are recorded but not enforced", async () => {
    await withObserver({ gate: false });
    const out = await runTask("x [[mock-verdicts observer=CHANGES_REQUESTED reviewer=REJECT]]");
    expect(out.kind).toBe("done");
    expect(count("developer")).toBe(1);
    expect(count("observer")).toBe(1);
    expect(count("reviewer")).toBe(1);
    const done = await store.get("t1");
    expect(done?.body.log).toContain("Observer verdict (round 1): CHANGES_REQUESTED");
    expect(done?.body.log).toContain("Reviewer verdict (round 1): REJECT");
    expect(done?.body.reports.reviewer).toContain("Round 1 — REJECT");
  });

  it("per-task tools.observer enables the observer without a global one", async () => {
    const out = await runTask("x", { tools: { ...fm().tools, observer: MOCK } });
    expect(out.kind).toBe("done");
    expect(count("observer")).toBe(1);
  });

  it("caps an over-limit diff in prompts and logs it", async () => {
    await withObserver({ maxInlineDiffBytes: 50 });
    mockState.onRun = async (opts) => {
      if (opts.role !== "developer") return;
      await writeIn(opts, "big.txt", "y".repeat(1024) + "\n");
      await gitOut(["add", "big.txt"], opts.cwd);
    };
    const out = await runTask("x");
    expect(out.kind).toBe("done");
    const base = (await gitOut(["rev-parse", "main"])).stdout.trim();
    const reviewPrompt = mockState.prompts.find((p) => p.includes("## Diff under review"))!;
    expect(reviewPrompt).toContain("exceeds the inline limit");
    expect(reviewPrompt).toContain(`git diff ${base}`);
    expect(reviewPrompt).toContain("big.txt");
    expect(reviewPrompt).not.toContain("yyyyyyyyyy");
    const done = await store.get("t1");
    expect(done?.body.log).toContain("Diff exceeds inline limit");
  });

  it("inlines the full diff when under the limit", async () => {
    mockState.onRun = async (opts) => {
      if (opts.role === "developer") await commitIn(opts, "small.txt");
    };
    const out = await runTask("x");
    expect(out.kind).toBe("done");
    const reviewPrompt = mockState.prompts.find((p) => p.includes("## Diff under review"))!;
    expect(reviewPrompt).toContain("## Diff\n");
    expect(reviewPrompt).not.toContain("exceeds the inline limit");
  });
});
