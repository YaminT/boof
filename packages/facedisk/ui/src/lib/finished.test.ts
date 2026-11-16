import { describe, expect, it } from "vitest";
import { EMPTY_FINISHED, FINISHED_TTL_MS, stepFinished, withFinished } from "./finished.js";
import type { TopbarState } from "./topbar.js";

const idle = (over: Partial<Parameters<typeof stepFinished>[1]> = {}) => ({
  kind: "idle" as const,
  running: [],
  queued: 0,
  now: 1000,
  ...over,
});
const state = (over: Partial<TopbarState> = {}): TopbarState => ({
  kind: "idle",
  tone: "idle",
  text: "Idle · 0 queued",
  toggle: null,
  stop: false,
  running: [],
  ...over,
});

describe("finished memory", () => {
  it("counts only the tasks that are done, not failed or stopped ones", () => {
    let m = stepFinished(EMPTY_FINISHED, idle({ kind: "running", running: ["p/a"] }));
    m = stepFinished(m, idle({ kind: "running", running: ["p/b"], queued: 1 }));
    m = stepFinished(m, idle({ now: 5000, notDone: ["p/b"] }));
    expect(m.finished).toEqual({ count: 1, at: 5000 });
    let all = stepFinished(EMPTY_FINISHED, idle({ kind: "running", running: ["p/a"] }));
    all = stepFinished(all, idle({ now: 5000, notDone: ["p/a"] }));
    expect(all.finished).toBeNull();
  });

  it("remembers the tasks that ran and finishes when the queue empties", () => {
    let m = stepFinished(EMPTY_FINISHED, idle({ kind: "running", running: ["p/a"] }));
    m = stepFinished(m, idle({ kind: "running", running: ["p/b"], queued: 1 }));
    expect(m.finished).toBeNull();
    m = stepFinished(m, idle({ now: 5000 }));
    expect(m.finished).toEqual({ count: 2, at: 5000 });
    expect(withFinished(state(), m, 5001)).toMatchObject({
      tone: "finished",
      text: "Finished · 2 done",
    });
  });

  it("does not finish with work still queued, or on an idle start", () => {
    const m = stepFinished(EMPTY_FINISHED, idle({ kind: "running", running: ["p/a"] }));
    expect(stepFinished(m, idle({ queued: 2 })).finished).toBeNull();
    expect(stepFinished(EMPTY_FINISHED, idle()).finished).toBeNull();
  });

  it("a pause is not a finish and keeps the memory", () => {
    const m = stepFinished(EMPTY_FINISHED, idle({ kind: "running", running: ["p/a"] }));
    expect(stepFinished(m, idle({ kind: "paused" }))).toBe(m);
  });

  it("new work clears it; the ttl expires it; only an idle bar shows it", () => {
    let m = stepFinished(EMPTY_FINISHED, idle({ kind: "running", running: ["p/a"] }));
    m = stepFinished(m, idle({ now: 2000 }));
    expect(stepFinished(m, idle({ kind: "running", running: ["p/c"] })).finished).toBeNull();
    expect(stepFinished(m, idle({ now: 2000 + FINISHED_TTL_MS })).finished).toBeNull();
    expect(withFinished(state(), m, 2000 + FINISHED_TTL_MS).tone).toBe("idle");
    expect(withFinished(state({ kind: "paused", tone: "paused" }), m, 2001).tone).toBe("paused");
  });
});
