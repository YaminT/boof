import { describe, expect, it } from "vitest";
import {
  contrast,
  stopAllRunning,
  stopSummary,
  topbarState,
  type RunnerOverview,
  type RunningItem,
  type TopbarInput,
} from "./topbar.js";

const item = (over: Partial<RunningItem> = {}): RunningItem => ({
  pid: "p1",
  project: "Alpha",
  taskId: "t1",
  title: "Build it",
  ...over,
});
const ov = (over: Partial<RunnerOverview> = {}): RunnerOverview => ({
  enabled: true,
  budgetExceeded: [],
  projects: [{ id: "p1", paused: false, running: [], counts: { pending: 2 } }],
  ...over,
});
const input = (over: Partial<TopbarInput> = {}): TopbarInput => ({
  overview: ov(),
  fallbackRunning: [],
  items: new Map(),
  held: "all",
  ...over,
});
const runningOv = (enabled = true, ids = ["t1"]) =>
  ov({ enabled, projects: [{ id: "p1", paused: false, running: ids, counts: {} }] });

describe("topbarState", () => {
  it("running with a plan shows plan and task and the step", () => {
    const s = topbarState(
      input({
        overview: runningOv(),
        items: new Map([["p1/t1", item({ plan: "Launch" })]]),
        step: "Developer",
      }),
    );
    expect(s.kind).toBe("running");
    expect(s.text).toBe("Running · Launch › Build it · Developer");
    expect(s.toggle).toEqual({ label: "Pause", disabled: false });
    expect(s.stop).toBe(true);
  });

  it("running without a plan omits the plan part", () => {
    const s = topbarState(input({ overview: runningOv(), items: new Map([["p1/t1", item()]]) }));
    expect(s.text).toBe("Running · Build it");
  });

  it("several tasks, also in another project", () => {
    const o = ov({
      projects: [
        { id: "p1", paused: false, running: ["a"], counts: {} },
        { id: "p2", paused: false, running: ["b", "c"], counts: {} },
      ],
    });
    const s = topbarState(input({ overview: o }));
    expect(s.text).toBe("Running 3 tasks");
    expect(s.running.map((r) => r.pid)).toEqual(["p1", "p2", "p2"]);
  });

  it("a task in another project is still running", () => {
    const o = ov({ projects: [{ id: "p2", paused: false, running: ["x"], counts: {} }] });
    const s = topbarState(
      input({ overview: o, items: new Map([["p2/x", item({ pid: "p2", project: "Beta" })]]) }),
    );
    expect(s.kind).toBe("running");
    expect(s.running[0].project).toBe("Beta");
  });

  it("paused with running tasks is draining; Start and Stop", () => {
    const s = topbarState(
      input({ overview: runningOv(false), items: new Map([["p1/t1", item()]]) }),
    );
    expect(s.kind).toBe("draining");
    expect(s.text).toBe("Paused · finishing Build it");
    expect(s.toggle?.label).toBe("Start");
    expect(s.stop).toBe(true);
  });

  it("idle counts queued tasks", () => {
    const s = topbarState(input());
    expect(s.kind).toBe("idle");
    expect(s.text).toBe("Runner on · waiting · 2 queued");
    expect(s.stop).toBe(false);
  });

  it("paused with nothing running", () => {
    const s = topbarState(input({ overview: ov({ enabled: false }) }));
    expect(s.kind).toBe("paused");
    expect(s.text).toBe("Paused · 2 queued");
    expect(s.toggle?.label).toBe("Start");
  });

  it("blocked: budget, all projects paused, no harness; Start disabled with the reason", () => {
    const budget = topbarState(input({ overview: ov({ budgetExceeded: [{}] }) }));
    expect(budget.kind).toBe("blocked");
    expect(budget.toggle).toEqual({ label: "Start", disabled: true, reason: "budget spent" });
    const paused = topbarState(
      input({ overview: ov({ projects: [{ id: "p1", paused: true, running: [], counts: {} }] }) }),
    );
    expect(paused.text).toBe("Cannot run: all projects paused");
    const none = topbarState(input({ noHarness: true }));
    expect(none.text).toBe("Cannot run: no harness installed");
  });

  it("without settings:read it falls back to the project's tasks and has no toggle", () => {
    const s = topbarState(
      input({
        overview: null,
        held: new Set(["tasks:read", "tasks:write"]),
        fallbackRunning: [item()],
      }),
    );
    expect(s.kind).toBe("running");
    expect(s.toggle).toBeNull();
    expect(s.stop).toBe(true);
    expect(topbarState(input({ overview: null })).kind).toBe("unknown");
  });

  it("without runner:control the toggle is hidden, Stop stays with tasks:write", () => {
    const held = new Set(["settings:read", "tasks:write"] as const);
    const s = topbarState(input({ overview: runningOv(), held }));
    expect(s.toggle).toBeNull();
    expect(s.stop).toBe(true);
    const noWrite = topbarState(input({ overview: runningOv(), held: new Set(["settings:read"]) }));
    expect(noWrite.stop).toBe(false);
  });
});

describe("stopAllRunning", () => {
  it("pauses first, then stops each task", async () => {
    const calls: string[] = [];
    const r = await stopAllRunning(
      [item({ taskId: "a" }), item({ pid: "p2", taskId: "b" })],
      async () => void calls.push("pause"),
      async (pid, id) => void calls.push(`stop ${pid}/${id}`),
    );
    expect(calls).toEqual(["pause", "stop p1/a", "stop p2/b"]);
    expect(r.failed).toEqual([]);
  });

  it("lists the tasks that did not stop and still tries the rest", async () => {
    const r = await stopAllRunning(
      [item({ taskId: "a" }), item({ taskId: "b" })],
      async () => undefined,
      async (_p, id) => {
        if (id === "a") throw new Error("busy");
      },
    );
    expect(r.failed.map((f) => [f.item.taskId, f.message])).toEqual([["a", "busy"]]);
  });

  it("stops nothing when the pause fails", async () => {
    const stopped: string[] = [];
    await expect(
      stopAllRunning(
        [item()],
        async () => {
          throw new Error("forbidden");
        },
        async (_p, id) => void stopped.push(id),
      ),
    ).rejects.toThrow("forbidden");
    expect(stopped).toEqual([]);
  });
});

describe("copy and contrast", () => {
  it("summarises the stop", () => {
    expect(stopSummary([item()])).toContain("1 running task");
    expect(stopSummary([item(), item()])).toContain("2 running tasks");
  });

  it("the running bar text is readable in both themes", () => {
    // Light: white on --done #2e7d52. Dark: --page #0f1418 on --done #5fbf8a.
    expect(contrast("#ffffff", "#2e7d52")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#0f1418", "#5fbf8a")).toBeGreaterThanOrEqual(4.5);
  });
});
