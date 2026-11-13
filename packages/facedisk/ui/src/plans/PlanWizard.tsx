import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { NativeSelect } from "../ui/native-select.js";
import { api, type Plan, type TaskView } from "../api.js";
import { act, errorMessage } from "../lib/act.js";
import { activateWithTasks, reportCreated } from "../lib/activate.js";
import { formatRoute, type Route } from "../lib/route.js";
import {
  OUTCOME_MAX,
  afterOutcome,
  agentUnavailableReason,
  blockedTools,
  draftFailureActions,
  draftFailureReason,
  readyTools,
  aboutDone,
  savedAbout,
  hasAbout,
  buildGoalInputs,
  clearDraft,
  defaultAgent,
  dismissWizard,
  emptyDraft,
  installedTools,
  itemsFromGoals,
  itemsProblems,
  loadDraft,
  newItem,
  outcomeProblem,
  planTitle,
  saveDraft,
  type WizardDraft,
  type WizardStep,
} from "../lib/wizard.js";
import { AnswerBox } from "../task/AnswerBox.js";
import { startPoller, type Poller } from "../lib/poller.js";
import { useLive } from "../useLive.js";
import { useHarnesses } from "../useHarnesses.js";
import type { AppData } from "../useAppData.js";
import { WizardTaskList } from "./WizardTaskList.js";

const FIELD = "text-[length:var(--text-body)] font-medium";
const ACTIVE = new Set(["pending", "running", "action"]);

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={FIELD}>{label}</span>
      {children}
      {hint && <span className="text-[length:var(--text-meta)] text-ink-muted">{hint}</span>}
    </label>
  );
}

/**
 * From "what do you want to end up with?" to a plan with tasks: outcome, project facts (once),
 * then the task list, written by hand or drafted by an installed coding agent.
 */
export function PlanWizard({
  pid,
  data,
  navigate,
  initialTitle,
}: {
  pid: string;
  data: AppData;
  navigate: (to: Route) => void;
  initialTitle?: string;
}) {
  const harnesses = useHarnesses(pid);
  const installed = useMemo(() => installedTools(harnesses.status), [harnesses.status]);
  const blocked = useMemo(() => blockedTools(harnesses.status), [harnesses.status]);
  const ready = useMemo(() => readyTools(harnesses.status), [harnesses.status]);
  const reason = agentUnavailableReason(harnesses.status);
  const [draft, setDraftState] = useState<WizardDraft>(
    () => loadDraft(window.sessionStorage, pid) ?? { ...emptyDraft(), title: initialTitle ?? "" },
  );
  const [models, setModels] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [task, setTask] = useState<TaskView | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const setDraft = useCallback(
    (patch: Partial<WizardDraft> | ((d: WizardDraft) => WizardDraft)) => {
      const next =
        typeof patch === "function" ? patch(draftRef.current) : { ...draftRef.current, ...patch };
      draftRef.current = next;
      saveDraft(window.sessionStorage, pid, next);
      setDraftState(next);
    },
    [pid],
  );

  // Preselect the agent once the install check and settings have answered.
  useEffect(() => {
    if (!harnesses.status || draftRef.current.tool) return;
    const pick = defaultAgent(data.settings, ready);
    setDraft((d) => ({ ...d, tool: pick.tool, model: pick.model, useAgent: d.useAgent }));
  }, [harnesses.status, ready, data.settings, setDraft]);

  // The models of the chosen tool, for the model select.
  useEffect(() => {
    let off = false;
    api
      .modelDetails()
      .then((t) => !off && setModels((t[draft.tool]?.models ?? []).map((m) => m.id)))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [draft.tool]);

  const loadPlan = useCallback(
    async (planId: string) => {
      try {
        const p = await api.getPlan(pid, planId);
        setPlan(p);
        if (p.draftTask) setTask(await api.getTask(pid, p.draftTask.id));
        else setTask(null);
        return p;
      } catch {
        return null;
      }
    },
    [pid],
  );

  // A restored draft with a plan reloads that plan; one whose plan is gone starts over.
  useEffect(() => {
    if (draft.planId)
      void loadPlan(draft.planId).then((p) => {
        if (!p) setDraft({ planId: null, step: "outcome" });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The draft is read when a live event names it; the poll is only a safety net.
  const planPoller = useRef<Poller | null>(null);
  const liveUp = useRef(false);
  useLive({
    onEvent: (e) => {
      if (e.type.startsWith("plan.") || e.type.startsWith("task.")) planPoller.current?.kick();
    },
    onChanged: () => planPoller.current?.kick(),
    onStatus: (up) => {
      liveUp.current = up;
      planPoller.current?.replan();
    },
  });

  const drafting = !!task && ACTIVE.has(task.frontmatter.status);
  // Follow the draft task while it runs; when it ends, take its goals into the list.
  const taskStatus = task?.frontmatter.status;
  const wasDrafting = useRef(false);
  useEffect(() => {
    if (!draft.planId || !drafting) return;
    const p = startPoller({
      load: async () => {
        await loadPlan(draftRef.current.planId!);
      },
      live: () => liveUp.current,
      liveMs: 10_000,
      fallbackMs: 2_000,
      minGapMs: 1_000,
    });
    planPoller.current = p;
    return () => {
      p.stop();
      planPoller.current = null;
    };
  }, [drafting, draft.planId, loadPlan]);
  useEffect(() => {
    if (drafting) wasDrafting.current = true;
    else if (wasDrafting.current && plan) {
      wasDrafting.current = false;
      if (taskStatus === "done" && plan.goals.length > 0)
        setDraft({ items: itemsFromGoals(plan.goals) });
    }
  }, [drafting, taskStatus, plan, setDraft]);

  const dismiss = () => {
    dismissWizard(window.localStorage, pid);
    clearDraft(window.sessionStorage, pid);
    navigate({ name: "overview", pid });
  };

  const goOutcomeNext = async () => {
    const p = outcomeProblem(draft.outcome);
    if (p) return setProblem(p);
    setProblem(null);
    if (draft.useAgent && !draft.tool) return setProblem("Pick an agent.");
    if (draft.useAgent && blocked[draft.tool])
      return setProblem(`${draft.tool} cannot start: ${blocked[draft.tool]}`);
    // The project facts live with the project on the server, so they are known in any browser.
    let known = null as Awaited<ReturnType<typeof api.getProject>> | null;
    try {
      known = await api.getProject(pid);
    } catch {
      /* without them the step is simply asked again */
    }
    const next: WizardStep = afterOutcome(aboutDone(known));
    const saved = savedAbout(known);
    // The saved answers prefill the draft; a draft the user already edited keeps its own.
    if (saved) setDraft((d) => ({ ...d, project: hasAbout(d.project) ? d.project : saved }));
    setDraft({ step: next });
    if (next === "tasks") startTaskList();
    if (next === "about" && !draft.project.stack && !draft.project.testCommand) {
      try {
        const d = await api.detectStack(pid);
        setDraft((x) => ({
          ...x,
          project: {
            ...x.project,
            stack: x.project.stack || d.stack,
            testCommand: x.project.testCommand || d.testCommand,
          },
        }));
      } catch {
        /* a failed scan leaves the fields empty */
      }
    }
  };

  /** The draft plan is created the first time the task list needs it. */
  const ensurePlan = async (): Promise<Plan | null> => {
    if (plan) return plan;
    const title = planTitle(draftRef.current);
    const created = await act(
      () =>
        api.createPlan(pid, {
          title,
          description: draftRef.current.outcome.trim(),
          goals: [],
        }),
      { failure: "Could not create the plan" },
    );
    if (!created) return null;
    setPlan(created);
    setDraft({ planId: created.id });
    return created;
  };

  /** The task step opens with one empty row when the tasks are written by hand. */
  const startTaskList = () => {
    if (!draftRef.current.useAgent && draftRef.current.items.length === 0)
      setDraft((d) => ({ ...d, items: [newItem()] }));
  };

  const goTasks = async () => {
    // Keep the answers with the project: next plan, and any other browser, starts from them.
    await act(() => api.updateProject(pid, { planDefaults: draftRef.current.project }), {
      failure: "Could not save the project answers",
    });
    setDraft({ step: "tasks" });
    startTaskList();
  };

  const draftTasks = async (note?: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const p = await ensurePlan();
      if (!p) return;
      // The shared fields and the current list go in first, so "adjust" reruns with the list.
      let current = p;
      if (draftRef.current.items.length) {
        const saved = await act(
          () =>
            api.replacePlanGoals(
              pid,
              current,
              buildGoalInputs(draftRef.current.items, draftRef.current.project, current.goals),
            ),
          { failure: "Could not save the list" },
        );
        if (!saved) return;
        current = saved;
        setPlan(saved);
      }
      const r = await act(
        () =>
          api.draftPlanGoals(pid, current.id, {
            tool: draftRef.current.tool,
            model: draftRef.current.model,
            ...(note?.trim() ? { note: note.trim() } : {}),
          }),
        {
          failure: "Could not start the agent",
          // The server refuses an agent that cannot start, with the reason: show it here.
          onError: (err) => {
            setProblem(errorMessage(err));
            harnesses.refresh();
            return true;
          },
        },
      );
      if (!r) return;
      setDraft({ note: "" });
      await loadPlan(current.id);
      void data.refresh();
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!task) return;
    await act(() => api.stopTask(pid, task.frontmatter.id), { failure: "Could not stop" });
    if (draft.planId) await loadPlan(draft.planId);
  };

  const createTasks = async () => {
    const problems = itemsProblems(draft.items);
    if (problems.length) return setProblem(problems[0]);
    setProblem(null);
    setBusy(true);
    try {
      const p = await ensurePlan();
      if (!p) return;
      const saved = await act(
        () => api.replacePlanGoals(pid, p, buildGoalInputs(draft.items, draft.project, p.goals)),
        { failure: "Could not save the tasks" },
      );
      if (!saved) return;
      const result = await act(() => activateWithTasks(pid, saved), {
        failure: "Could not create the tasks",
      });
      if (!result) return;
      const active = result.plan;
      reportCreated(result.created);
      clearDraft(window.sessionStorage, pid);
      dismissWizard(window.localStorage, pid);
      void data.refresh();
      navigate({ name: "plans", pid, planId: active.id });
    } finally {
      setBusy(false);
    }
  };

  const failureReason = task ? draftFailureReason(task) : null;
  const failureActions = draftFailureActions(failureReason);
  /** Back to the first step to pick another agent; the failed attempt is dropped from view. */
  const useDifferentAgent = () => {
    setTask(null);
    harnesses.refresh();
    const next = ready.find((t) => t !== draftRef.current.tool) ?? "";
    setDraft({ step: "outcome", ...(next ? { tool: next, model: "" } : {}) });
  };

  const step = draft.step;
  const agentReady = !reason && ready.length > 0;
  const proj = draft.project;
  const setProj = (patch: Partial<typeof proj>) => setDraft({ project: { ...proj, ...patch } });

  return (
    <div className="flex max-w-[760px] flex-col gap-4">
      <div className="flex items-center gap-2">
        <h2 className="m-0 text-[length:var(--text-title)] font-semibold">
          New plan from an outcome
        </h2>
        <Button className="ml-auto" size="xs" variant="ghost" onClick={dismiss}>
          Skip for now
        </Button>
      </div>
      <p className="m-0 text-ink-muted">
        Step {step === "outcome" ? 1 : step === "about" ? 2 : 3} of 3 ·{" "}
        {step === "outcome" ? "Outcome" : step === "about" ? "About this project" : "Tasks"}
      </p>

      {step === "outcome" && (
        <div className="flex flex-col gap-3">
          <Field label="What do you want to end up with?">
            <Textarea
              rows={6}
              maxLength={OUTCOME_MAX}
              value={draft.outcome}
              onChange={(e) => setDraft({ outcome: e.target.value })}
            />
          </Field>
          <Field label="Title (optional)" hint="Left empty, the first line of the outcome is used.">
            <Input
              value={draft.title}
              maxLength={120}
              onChange={(e) => setDraft({ title: e.target.value })}
            />
          </Field>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.useAgent && agentReady}
              disabled={!agentReady}
              onChange={(e) => setDraft({ useAgent: e.target.checked })}
            />
            <span className={FIELD}>Let an agent write the tasks</span>
          </label>
          {reason && <p className="m-0 text-ink-muted">{reason}</p>}
          {draft.useAgent && agentReady && Object.keys(blocked).length > 0 && (
            <ul className="m-0 list-none p-0 text-ink-muted">
              {Object.entries(blocked).map(([t, why]) => (
                <li key={t}>
                  {harnesses.status?.tools[t]?.displayName ?? t} cannot start here: {why}
                </li>
              ))}
            </ul>
          )}
          {draft.useAgent && agentReady && (
            <div className="flex flex-wrap gap-2">
              <NativeSelect
                aria-label="Agent"
                value={draft.tool}
                onChange={(e) => setDraft({ tool: e.target.value, model: "" })}
              >
                {installed.map((t) => (
                  <option key={t} value={t} disabled={!!blocked[t]}>
                    {harnesses.status?.tools[t]?.displayName ?? t}
                    {blocked[t] ? " (cannot start here)" : ""}
                  </option>
                ))}
              </NativeSelect>
              {models.length > 0 ? (
                <NativeSelect
                  aria-label="Model"
                  value={draft.model}
                  onChange={(e) => setDraft({ model: e.target.value })}
                >
                  {draft.model && !models.includes(draft.model) && (
                    <option value={draft.model}>{draft.model}</option>
                  )}
                  {!draft.model && <option value="">Choose a model</option>}
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                <Input
                  aria-label="Model"
                  className="w-56"
                  placeholder="Model"
                  value={draft.model}
                  onChange={(e) => setDraft({ model: e.target.value })}
                />
              )}
            </div>
          )}
          {problem && (
            <p role="alert" className="m-0 text-danger">
              {problem}
            </p>
          )}
          <div>
            <Button onClick={() => void goOutcomeNext()}>Next</Button>
          </div>
        </div>
      )}

      {step === "about" && (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-ink-muted">
            Every task shares these. They were guessed from the project folder; correct them if
            needed.
          </p>
          <Field label="Stack">
            <Input value={proj.stack} onChange={(e) => setProj({ stack: e.target.value })} />
          </Field>
          <Field label="Test command">
            <Input
              value={proj.testCommand}
              onChange={(e) => setProj({ testCommand: e.target.value })}
            />
          </Field>
          <Field label="Always do (one per line)">
            <Textarea
              rows={3}
              value={proj.doRules}
              onChange={(e) => setProj({ doRules: e.target.value })}
            />
          </Field>
          <Field label="Never do (one per line)">
            <Textarea
              rows={3}
              value={proj.dontRules}
              onChange={(e) => setProj({ dontRules: e.target.value })}
            />
          </Field>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setDraft({ step: "outcome" })}>
              Back
            </Button>
            <Button onClick={goTasks}>Next</Button>
          </div>
        </div>
      )}

      {step === "tasks" && (
        <div className="flex flex-col gap-3">
          {draft.useAgent && agentReady && !drafting && draft.items.length === 0 && !task && (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-ink-muted">
                {draft.tool} will read the project and write the tasks. You can change them before
                they are created.
              </p>
              <div>
                <Button disabled={busy} onClick={() => void draftTasks()}>
                  Draft tasks
                </Button>
              </div>
            </div>
          )}
          {task && (
            <div
              className="flex flex-col gap-2 rounded-lg border border-line p-3"
              aria-live="polite"
            >
              <div>
                {drafting
                  ? task.frontmatter.status === "action"
                    ? "The agent has questions."
                    : `The agent is drafting tasks${task.frontmatter.steps?.length ? `: ${task.frontmatter.steps[task.frontmatter.steps.length - 1].label}` : "…"}`
                  : task.frontmatter.status === "done"
                    ? "The agent finished drafting."
                    : `The agent ${task.frontmatter.status}.`}
              </div>
              {failureReason && (
                <div className="flex flex-col gap-2">
                  <p role="alert" className="m-0 text-danger">
                    {failureReason}
                  </p>
                  <div className="flex gap-2">
                    {failureActions.includes("change-agent") && (
                      <Button variant="outline" onClick={useDifferentAgent}>
                        Use a different agent
                      </Button>
                    )}
                    {failureActions.includes("settings") && (
                      <Button
                        variant="outline"
                        onClick={() => navigate({ name: "settings", pid, page: "project" })}
                      >
                        Open project settings
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {task.frontmatter.status === "action" && (
                <>
                  {task.body.questions?.trim() && (
                    <p className="m-0 max-w-[80ch] whitespace-pre-wrap">{task.body.questions}</p>
                  )}
                  <AnswerBox
                    pid={pid}
                    taskId={task.frontmatter.id}
                    onSent={() => loadPlan(plan!.id).then(() => undefined)}
                  />
                </>
              )}
              {drafting && (
                <div>
                  <Button variant="outline" onClick={() => void stop()}>
                    Stop
                  </Button>
                </div>
              )}
            </div>
          )}
          {!drafting && (draft.items.length > 0 || !draft.useAgent || task) && (
            <>
              <WizardTaskList
                items={draft.items}
                disabled={busy}
                onChange={(items) => setDraft({ items })}
              />
              {draft.useAgent && agentReady && (
                <div className="flex flex-col gap-2">
                  <Field label="Ask the agent to adjust (optional note)">
                    <Input
                      value={draft.note}
                      onChange={(e) => setDraft({ note: e.target.value })}
                    />
                  </Field>
                  <div>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void draftTasks(draft.note)}
                    >
                      Ask the agent to adjust
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
          {problem && (
            <p role="alert" className="m-0 text-danger">
              {problem}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={drafting}
              onClick={() => setDraft({ step: "outcome" })}
            >
              Back
            </Button>
            <Button
              disabled={busy || drafting || draft.items.length === 0}
              onClick={() => void createTasks()}
            >
              Create tasks
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
