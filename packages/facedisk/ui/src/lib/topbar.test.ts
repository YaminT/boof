import { describe, expect, it } from "vitest";
import {
  contrast,
  formatResumeTime,
  nextStep,
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

  it("waits for a spent budget and says when it resumes instead of an error", () => {
    const s = topbarState(
      input({
        overview: ov({ budgetExceeded: [{}] }),
        resetAt: "2026-11-12T14:05:00Z",
        timeZone: "UTC",
      }),
    );
    expect(s.kind).toBe("waiting");
    expect(s.text).toBe("Waiting for usage-limit reset, resumes at 14:05");
    expect(s.toggle).toEqual({ label: "Pause", disabled: false });
    expect(topbarState(input({ overview: ov({ budgetExceeded: [{}] }) })).text).toBe(
      "Waiting for usage-limit reset",
    );
  });

  it("waits when every pool account hit its usage limit, using the pool's next time", () => {
    const s = topbarState(
      input({
        overview: ov({
          pool: {
            status: "unhealthy",
            routable: 0,
            usageExhausted: 2,
            nextAvailableAt: "2026-11-12T09:30:00Z",
          },
        }),
        timeZone: "UTC",
      }),
    );
    expect(s.text).toBe("Waiting for usage-limit reset, resumes at 09:30");
    // One account still routes: not waiting.
    const ok = topbarState(
      input({ overview: ov({ pool: { routable: 1, usageExhausted: 1, nextAvailableAt: null } }) }),
    );
    expect(ok.kind).toBe("idle");
  });

  it("running tasks and a missing harness win over waiting", () => {
    const run = topbarState(
      input({
        overview: { ...runningOv(), budgetExceeded: [{}] },
        items: new Map([["p1/t1", item()]]),
      }),
    );
    expect(run.kind).toBe("running");
    const none = topbarState(input({ overview: ov({ budgetExceeded: [{}] }), noHarness: true }));
    expect(none.kind).toBe("blocked");
  });

  it("blocked: all projects paused, no harness; Start disabled with the reason", () => {
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

describe("Stop for a key that cannot write settings", () => {
  it("is shown for runner:control + tasks:control without settings:write", () => {
    const held = new Set(["settings:read", "runner:control", "tasks:control"] as const);
    const s = topbarState(input({ overview: runningOv(), held }));
    expect(s.stop).toBe(true);
    expect(s.toggle).not.toBeNull();
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

  it("still stops the tasks when the pause is refused, and says so", async () => {
    const stopped: string[] = [];
    const r = await stopAllRunning(
      [item({ taskId: "a" }), item({ taskId: "b" })],
      async () => {
        throw new Error("forbidden");
      },
      async (_p, id) => void stopped.push(id),
    );
    expect(stopped).toEqual(["a", "b"]);
    expect(r).toEqual({ failed: [], pauseFailed: "forbidden" });
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

describe("formatResumeTime", () => {
  it("formats HH:MM and refuses bad input", () => {
    expect(formatResumeTime("2026-11-12T00:07:00Z", "UTC")).toBe("00:07");
    expect(formatResumeTime("nope")).toBeNull();
    expect(formatResumeTime(null)).toBeNull();
  });
});

describe("nextStep", () => {
  const base = { kind: "idle" as const, queued: 0, tasks: [], plans: [] };
  it("suggests planning when the queue is empty", () => {
    expect(nextStep(base)).toMatchObject({ to: "wizard", text: "Nothing queued" });
  });
  it("suggests queueing drafts first", () => {
    const s = nextStep({ ...base, tasks: [{ status: "draft" }, { status: "done" }] });
    expect(s).toMatchObject({ to: "tasks", text: "1 draft task not queued yet" });
  });
  it("suggests the next step after a finished plan", () => {
    const s = nextStep({
      ...base,
      tasks: [{ status: "done" }],
      plans: [{ title: "Launch", status: "active", goalCount: 3, doneCount: 3 }],
    });
    expect(s).toMatchObject({ to: "wizard", text: 'Plan "Launch" is finished' });
  });
  it("is silent while work runs, waits or is queued", () => {
    expect(nextStep({ ...base, kind: "running" })).toBeNull();
    expect(nextStep({ ...base, kind: "waiting" })).toBeNull();
    expect(nextStep({ ...base, queued: 2 })).toBeNull();
    expect(nextStep({ ...base, tasks: [{ status: "action" }] })).toBeNull();
  });
});
