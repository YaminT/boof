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
  draftWait,
  elapsedText,
  prepareRunner,
  RUNNER_STARTED_NOTICE,
  DRAFT_PENDING_GRACE_MS,
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
      Object.entries(tools).map(([k, v]) => [
        k,
        { displayName: k, installed: v, message: "", ready: v, readyReason: "" },
      ]),
    ),
    anyInstalled: Object.values(tools).some(Boolean),
    anyReady: Object.values(tools).some(Boolean),
    gateway: { status: "ok" as const, message: "" },
    checks: [],
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
        ready: true,
        readyReason: "",
        startBlock: "claude-agent cannot start: no gateway",
      },
      "claude-code": {
        displayName: "Claude Code",
        installed: true,
        message: "",
        ready: true,
        readyReason: "",
      },
      codex: { displayName: "Codex", installed: false, message: "", ready: false, readyReason: "" },
    },
    anyInstalled: true,
    anyReady: true,
    gateway: { status: "ok" as const, message: "" },
    checks: [],
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

describe("draftWait", () => {
  const paused = {
    kind: "paused",
    text: "Paused · 1 queued",
    toggle: { label: "Start", disabled: false },
  };
  it("names the state and the elapsed time", () => {
    expect(draftWait({ status: "pending", elapsedMs: 5_000, topbar: paused })).toEqual({
      state: "Waiting in the queue",
      elapsed: "5 s",
    });
    expect(draftWait({ status: "running", elapsedMs: 65_000, topbar: null })).toEqual({
      state: "The agent is working",
      elapsed: "1 min 05 s",
    });
  });
  it("explains a pending draft only after the grace time", () => {
    const late = draftWait({
      status: "pending",
      elapsedMs: DRAFT_PENDING_GRACE_MS + 1,
      topbar: paused,
    });
    expect(late.why).toBe("Paused · 1 queued");
    expect(late.action).toBe("start-runner");
  });
  it("passes on the usage-limit reset time and offers no action for it", () => {
    const w = draftWait({
      status: "pending",
      elapsedMs: 60_000,
      topbar: {
        kind: "waiting",
        text: "Waiting for usage-limit reset, resumes at 14:05",
        toggle: { label: "Pause", disabled: false },
      },
    });
    expect(w.why).toContain("resumes at 14:05");
    expect(w.action).toBeUndefined();
  });
  it("sends a missing agent to the setup check", () => {
    const w = draftWait({
      status: "pending",
      elapsedMs: 60_000,
      topbar: {
        kind: "blocked",
        text: "Cannot run: no agent ready",
        toggle: { label: "Start", disabled: true },
      },
    });
    expect(w.action).toBe("fix-agents");
  });
  it("says nothing while the runner is busy or idle", () => {
    const w = draftWait({
      status: "pending",
      elapsedMs: 60_000,
      topbar: { kind: "running", text: "Running", toggle: null },
    });
    expect(w.why).toBeUndefined();
  });
  it("formats elapsed time", () => {
    expect(elapsedText(0)).toBe("0 s");
    expect(elapsedText(125_000)).toBe("2 min 05 s");
  });
});

describe("prepareRunner", () => {
  it("starts a runner that is off and says so", async () => {
    let started = 0;
    const r = await prepareRunner({
      enabled: false,
      canControl: true,
      start: async () => void started++,
    });
    expect(started).toBe(1);
    expect(r).toEqual({ ok: true, notice: RUNNER_STARTED_NOTICE });
  });
  it("leaves a running runner alone, and an unreadable status", async () => {
    const start = async () => {
      throw new Error("no");
    };
    expect(await prepareRunner({ enabled: true, canControl: true, start })).toEqual({ ok: true });
    expect(await prepareRunner({ enabled: null, canControl: false, start })).toEqual({ ok: true });
  });
  it("blocks with the reason when the key may not start it", async () => {
    const r = await prepareRunner({ enabled: false, canControl: false, start: async () => {} });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problem).toContain("runner:control");
  });
  it("reports a failed start", async () => {
    const r = await prepareRunner({
      enabled: false,
      canControl: true,
      start: async () => {
        throw new Error("boom");
      },
    });
    expect(r).toEqual({ ok: false, problem: "Could not start the runner: boom" });
  });
});
