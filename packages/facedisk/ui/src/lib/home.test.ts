import { describe, expect, it } from "vitest";
import type { Project } from "@boof/heart/schema";
import { filterCards, homeCards, progressOf, stateOf, summaryOf } from "./home.js";
import type { RunnerOverview } from "./topbar.js";

const proj = (id: string, extra: Partial<Project> = {}) =>
  ({
    id,
    name: id.toUpperCase(),
    workingDirectory: `/w/${id}`,
    paused: false,
    archived: false,
    ...extra,
  }) as Project;

const overview = (projects: RunnerOverview["projects"]): RunnerOverview => ({
  enabled: true,
  budgetExceeded: [],
  projects,
});

describe("progressOf", () => {
  it("counts done over everything still in play", () => {
    expect(progressOf({ done: 7, running: 1, pending: 2, action: 1, failed: 0, draft: 5 })).toEqual(
      {
        done: 7,
        total: 11,
        percent: 64,
        text: "7 of 11 tasks done",
      },
    );
  });
  it("shows 0 of 0 gracefully", () => {
    expect(progressOf({})).toMatchObject({ total: 0, percent: 0, text: "No tasks yet" });
  });
});

describe("stateOf", () => {
  const row = (o: object) => ({ paused: false, running: [], counts: {}, ...o });
  it("ranks needs-you over running over blocked over paused", () => {
    expect(stateOf(row({ counts: { action: 2 }, running: ["a"] })).label).toBe("Needs you: 2");
    expect(stateOf(row({ running: ["a"] })).state).toBe("running");
    expect(stateOf(row({ counts: { failed: 1 } })).state).toBe("blocked");
    expect(stateOf(row({ paused: true })).state).toBe("paused");
    expect(stateOf(row({})).state).toBe("idle");
    expect(stateOf(undefined).state).toBe("idle");
  });
});

describe("homeCards", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  const ov = overview([
    {
      id: "a",
      paused: false,
      running: [],
      counts: { done: 1 },
      lastActivity: "2026-11-16T11:00:00Z",
    },
    {
      id: "b",
      paused: false,
      running: ["t"],
      counts: { running: 1 },
      lastActivity: "2026-11-16T09:00:00Z",
    },
    {
      id: "c",
      paused: false,
      running: [],
      counts: { action: 1 },
      lastActivity: "2026-11-10T09:00:00Z",
    },
    {
      id: "d",
      paused: true,
      running: [],
      counts: {},
      lastActivity: "2026-11-16T11:55:00Z",
      plans: { activeTitle: "Ship", goalsDone: 7, goalsTotal: 11 },
    },
  ]);
  const cards = homeCards([proj("a"), proj("b"), proj("c"), proj("d")], ov, now);
  it("sorts needs-you, running, then recent activity", () => {
    expect(cards.map((c) => c.project.id)).toEqual(["c", "b", "d", "a"]);
  });
  it("carries plan, goals and activity text", () => {
    const d = cards.find((c) => c.project.id === "d")!;
    expect(d.planTitle).toBe("Ship");
    expect(d.goalsText).toBe("goals 7/11");
    expect(d.activityText).toBe("active 5m ago");
  });
  it("sorts cards without lastActivity by name, after the ones with activity", () => {
    const row = (id: string, lastActivity?: string) => ({
      id,
      paused: false,
      running: [],
      counts: {},
      ...(lastActivity ? { lastActivity } : {}),
    });
    const ids = homeCards(
      [proj("z"), proj("x"), proj("m"), proj("y")],
      overview([row("z"), row("x"), row("m", "2026-11-16T11:00:00Z"), row("y")]),
      now,
    ).map((c) => c.project.id);
    expect(ids).toEqual(["m", "x", "y", "z"]);
  });
  it("copes with no overview", () => {
    expect(homeCards([proj("a")], null)[0]).toMatchObject({ state: "idle", total: 0 });
  });
  it("summarises and filters", () => {
    expect(summaryOf(cards)).toEqual({ running: 1, queued: 0, needsYou: 1, doneToday: 0 });
    expect(filterCards(cards, "  B ").map((c) => c.project.id)).toEqual(["b"]);
    expect(filterCards(cards, "/w/c").map((c) => c.project.id)).toEqual(["c"]);
  });
});
