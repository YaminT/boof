import { describe, expect, it } from "vitest";
import type { Goal } from "../api.js";
import {
  afterOutcome,
  aboutDone,
  agentUnavailableReason,
  assignIds,
  buildGoalInputs,
  clearDraft,
  blockedTools,
  defaultAgent,
  draftFailureActions,
  draftFailureReason,
  readyTools,
  dismissWizard,
  emptyDraft,
  installedTools,
  isDismissed,
  itemsFromGoals,
  itemsProblems,
  loadDraft,
  moveItem,
  newItem,
  outcomeProblem,
  planTitle,
  saveDraft,
  savedAbout,
  shouldAutoOpen,
  type WizardProject,
} from "./wizard.js";

const store = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};
const project: WizardProject = {
  stack: "TypeScript",
  testCommand: "npm test",
  doRules: "Keep it small\n\nAdd tests",
  dontRules: "",
};
const goal = (id: string, title: string, dependsOn: string[] = [], g = title): Goal =>
  ({
    id,
    title,
    dependsOn,
    spec: {
      goal: g,
      stack: "S",
      rules: { do: ["x"], dont: [] },
      tests: { strategy: "a", technology: "b", run: "c" },
    },
  }) as unknown as Goal;

describe("title and outcome", () => {
  it("defaults the title to the first line, capped at 120", () => {
    expect(planTitle({ title: "", outcome: "\n  Ship it\nmore" })).toBe("Ship it");
    expect(planTitle({ title: "", outcome: "x".repeat(300) })).toHaveLength(120);
    expect(planTitle({ title: " Mine ", outcome: "other" })).toBe("Mine");
  });
  it("requires an outcome of at most 20000 characters", () => {
    expect(outcomeProblem("  ")).toBeTruthy();
    expect(outcomeProblem("x".repeat(20_001))).toBeTruthy();
    expect(outcomeProblem("ok")).toBeNull();
  });
  it("asks about the project once", () => {
    expect(afterOutcome(false)).toBe("about");
    expect(afterOutcome(true)).toBe("tasks");
  });
});

describe("goal inputs", () => {
  it("builds shared specs, order and previous-task dependencies", () => {
    const a = newItem("Set up");
    const b = { ...newItem("Build it"), details: "Do the thing", afterPrevious: true };
    const out = buildGoalInputs([a, b], project);
    expect(out.map((g) => g.id)).toEqual(["set-up", "build-it"]);
    expect(out[1].dependsOn).toEqual(["set-up"]);
    expect(out[0].dependsOn).toEqual([]);
    expect(out[1].order).toBe(2);
    expect(out[0].spec.goal).toBe("Set up");
    expect(out[1].spec.goal).toBe("Do the thing");
    expect(out[0].spec.rules.do).toEqual(["Keep it small", "Add tests"]);
    expect(out[0].spec.tests.run).toBe("npm test");
  });
  it("suffixes clashing ids and keeps existing ones", () => {
    const items = [newItem("Same"), newItem("Same"), { ...newItem("Renamed"), goalId: "same" }];
    expect(assignIds(items)).toEqual(["same-2", "same-3", "same"]);
  });
  it("fills fallbacks so an empty project still validates", () => {
    const [g] = buildGoalInputs([newItem("T")], {
      stack: "",
      testCommand: "",
      doRules: "",
      dontRules: "",
    });
    expect(g.spec.stack).toBeTruthy();
    expect(g.spec.rules.do.length).toBe(1);
    expect(g.spec.tests.run).toBeTruthy();
  });
  it("keeps an existing goal's spec and only replaces its text", () => {
    const old = [goal("a", "A"), goal("b", "B", ["a"])];
    const items = itemsFromGoals(old);
    expect(items[1].afterPrevious).toBe(true);
    items[0].details = "new text";
    const out = buildGoalInputs(items, project, old);
    expect(out[0].spec.stack).toBe("S");
    expect(out[0].spec.goal).toBe("new text");
    expect(out[1].dependsOn).toEqual(["a"]);
  });
  it("problems: empty list and blank titles", () => {
    expect(itemsProblems([])).toHaveLength(1);
    expect(itemsProblems([newItem("")])).toEqual(["Every task needs a title."]);
    expect(itemsProblems([newItem("ok")])).toEqual([]);
  });
});

describe("list edits", () => {
  it("moves items", () => {
    const [a, b, c] = ["a", "b", "c"].map((t) => newItem(t));
    expect(moveItem([a, b, c], 2, 0).map((i) => i.title)).toEqual(["c", "a", "b"]);
    expect(moveItem([a, b], 0, 5).map((i) => i.title)).toEqual(["a", "b"]);
  });
});

describe("agents", () => {
  const status = (tools: Record<string, boolean>) => ({
    tools: Object.fromEntries(
      Object.entries(tools).map(([k, v]) => [k, { displayName: k, installed: v, message: "" }]),
    ),
    anyInstalled: Object.values(tools).some(Boolean),
    checkedAt: "",
  });
  it("lists installed tools and explains when none is", () => {
    expect(installedTools(status({ codex: true, opencode: false }))).toEqual(["codex"]);
    expect(installedTools(null)).toEqual([]);
    expect(agentUnavailableReason(status({ codex: false }))).toMatch(/No coding agent/);
    expect(agentUnavailableReason(null)).toMatch(/Checking/);
    expect(agentUnavailableReason(status({ codex: true }))).toBeNull();
  });
  it("prefers the active profile's advisor, then the planner role, if installed", () => {
    const settings = {
      roles: { planner: { tool: "codex", model: "m1" } },
      profiles: [{ id: "p", roles: { planner: { tool: "claude-code", model: "m2" } } }],
      activeProfile: "p",
    };
    expect(defaultAgent(settings, ["claude-code", "codex"])).toEqual({
      tool: "claude-code",
      model: "m2",
    });
    expect(defaultAgent(settings, ["codex"])).toEqual({ tool: "codex", model: "m1" });
    expect(defaultAgent({ roles: settings.roles }, ["codex"])).toEqual({
      tool: "codex",
      model: "m1",
    });
    expect(defaultAgent(null, [])).toEqual({ tool: "", model: "" });
  });
});

describe("agents that cannot start", () => {
  const status = {
    tools: {
      "claude-agent": {
        displayName: "Claude Agent",
        installed: true,
        message: "",
        startBlock: "claude-agent cannot start: no gateway",
      },
      "claude-code": { displayName: "Claude Code", installed: true, message: "" },
      codex: { displayName: "Codex", installed: false, message: "" },
    },
    anyInstalled: true,
    checkedAt: "",
  };
  it("separates installed tools that cannot start and never preselects them", () => {
    expect(blockedTools(status)).toEqual({
      "claude-agent": "claude-agent cannot start: no gateway",
    });
    expect(readyTools(status)).toEqual(["claude-code"]);
    const settings = { roles: { planner: { tool: "claude-agent", model: "m" } } };
    expect(defaultAgent(settings, readyTools(status))).toEqual({ tool: "claude-code", model: "" });
  });
  it("explains when every installed agent is blocked", () => {
    const only = { ...status, tools: { "claude-agent": status.tools["claude-agent"] } };
    expect(agentUnavailableReason(only)).toMatch(/can start.*no gateway/);
    expect(agentUnavailableReason(status)).toBeNull();
  });
});

describe("draft failure reason", () => {
  const task = (status: string, log: string) => ({ frontmatter: { status }, body: { log } });
  it("takes the first line after the Not started heading", () => {
    const log =
      "### Not started\nclaude-agent cannot start: no better-ccflare gateway is configured. Set an Anthropic API key (Settings › Project).\nmore";
    const reason = draftFailureReason(task("failed", log));
    expect(reason).toMatch(/^claude-agent cannot start: no better-ccflare gateway/);
    expect(reason).not.toContain("more");
    expect(draftFailureActions(reason)).toEqual(["change-agent", "settings"]);
  });
  it("skips headings and blank lines, hides paths and secrets, and cuts it short", () => {
    const reason = draftFailureReason(
      task("failed", "\n## Log\nfailed in /home/me/proj/x.ts with sk-ant-api03-abcdefghijklmnop\n"),
    );
    expect(reason).toBe("failed in [path] with [key]");
    expect(draftFailureReason(task("failed", `${"a".repeat(500)}`))!.length).toBe(300);
    expect(draftFailureActions(reason)).toEqual(["change-agent"]);
  });
  it("is null for a task that did not fail or has no log", () => {
    expect(draftFailureReason(task("done", "x"))).toBeNull();
    expect(draftFailureReason(task("failed", ""))).toBeNull();
  });
});

describe("storage", () => {
  it("restores a draft per project and ignores junk", () => {
    const s = store();
    const d = { ...emptyDraft(), outcome: "Hello", planId: "hello", step: "tasks" as const };
    saveDraft(s, "p1", d);
    expect(loadDraft(s, "p1")).toEqual(d);
    expect(loadDraft(s, "p2")).toBeNull();
    s.setItem("boof.wizard.draft.p3", "{not json");
    expect(loadDraft(s, "p3")).toBeNull();
    s.setItem("boof.wizard.draft.p4", JSON.stringify({ outcome: "x" }));
    expect(loadDraft(s, "p4")?.project.stack).toBe("");
    clearDraft(s, "p1");
    expect(loadDraft(s, "p1")).toBeNull();
  });
  it("remembers a dismissal per project", () => {
    const s = store();
    expect(isDismissed(s, "a")).toBe(false);
    dismissWizard(s, "a");
    expect(isDismissed(s, "a")).toBe(true);
    expect(isDismissed(s, "b")).toBe(false);
  });
  it("opens by itself only for an empty, loaded, undismissed project", () => {
    const base = { loaded: true, taskCount: 0, planCount: 0, dismissed: false };
    expect(shouldAutoOpen(base)).toBe(true);
    expect(shouldAutoOpen({ ...base, loaded: false })).toBe(false);
    expect(shouldAutoOpen({ ...base, taskCount: 1 })).toBe(false);
    expect(shouldAutoOpen({ ...base, planCount: 1 })).toBe(false);
    expect(shouldAutoOpen({ ...base, dismissed: true })).toBe(false);
  });
});

describe("project answers kept with the project", () => {
  const answers: WizardProject = {
    stack: "TypeScript",
    testCommand: "npm test",
    doRules: "a",
    dontRules: "b",
  };
  it("is done only when the project holds the answers, not because of a browser flag", () => {
    expect(aboutDone(null)).toBe(false);
    expect(aboutDone({})).toBe(false);
    expect(aboutDone({ planDefaults: answers })).toBe(true);
  });
  it("hands the saved answers back to prefill the next plan", () => {
    expect(savedAbout({ planDefaults: answers })).toEqual(answers);
    expect(savedAbout({})).toBeNull();
  });
});
