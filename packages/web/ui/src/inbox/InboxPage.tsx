import { useState } from "react";
import { api, type PlanSummary, type TaskView } from "../api.js";
import { Button } from "@/ui/button";
import { act } from "../lib/act.js";
import { inboxGroups, type InboxGroup } from "../lib/inbox.js";
import { formatRoute, type Route } from "../lib/route.js";
import { groupTasks } from "../lib/task-groups.js";
import { AnswerBox } from "../task/AnswerBox.js";
import type { AppData } from "../useAppData.js";

const PROSE = "m-0 max-w-[80ch] text-[length:var(--text-body)] whitespace-pre-wrap";

function Question({ task, onChange }: { task: TaskView; onChange: () => void }) {
  const [all, setAll] = useState(false);
  const text = task.body.questions?.trim() || "(no question text)";
  const lines = text.split("\n");
  const long = lines.length > 6;
  const shown = all || !long ? text : lines.slice(0, 6).join("\n");
  const href = formatRoute({
    name: "task",
    pid: task.projectId,
    taskId: task.frontmatter.id,
    view: "questions",
  });
  return (
    <li className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <a href={href} className="font-medium text-ink no-underline hover:underline">
          {task.frontmatter.title}
        </a>
        <span className="text-[length:var(--text-row)] text-attention">Asks a question</span>
      </div>
      <p className={PROSE}>{shown}</p>
      {long && !all && (
        <Button variant="ghost" size="xs" className="self-start" onClick={() => setAll(true)}>
          Show all
        </Button>
      )}
      <AnswerBox pid={task.projectId} taskId={task.frontmatter.id} onSent={onChange} />
    </li>
  );
}

function Proposed({
  task,
  onChange,
  navigate,
}: {
  task: TaskView;
  onChange: () => void;
  navigate: (to: Route) => void;
}) {
  const pid = task.projectId;
  const id = task.frontmatter.id;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line py-3 last:border-b-0">
      <span className="min-w-[8rem] flex-1 font-medium">{task.frontmatter.title}</span>
      <span className="text-[length:var(--text-row)] text-attention">Proposed</span>
      <Button
        onClick={() =>
          void act(() => api.updateTask(pid, id, { status: "pending" }), {
            failure: "Could not queue",
            success: "Queued",
          }).then((ok) => ok && onChange())
        }
      >
        Queue
      </Button>
      <Button
        variant="outline"
        onClick={() => navigate({ name: "task", pid, taskId: id, view: "edit" })}
      >
        Open
      </Button>
    </li>
  );
}

function DraftPlan({
  pid,
  plan,
  onChange,
  navigate,
}: {
  pid: string;
  plan: PlanSummary;
  onChange: () => void;
  navigate: (to: Route) => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line py-3 last:border-b-0">
      <span className="min-w-[8rem] flex-1 font-medium">{plan.title}</span>
      <span className="text-[length:var(--text-row)] text-attention">Draft plan</span>
      <Button
        onClick={() =>
          void act(() => api.updatePlan(pid, plan, { status: "active" }), {
            failure: "Could not activate the plan",
            success: "Plan activated",
          }).then((ok) => ok && onChange())
        }
      >
        Activate plan
      </Button>
      <Button variant="outline" onClick={() => navigate({ name: "plans", pid, planId: plan.id })}>
        Open plan
      </Button>
    </li>
  );
}

function Group({
  group,
  onChange,
  navigate,
}: {
  group: InboxGroup;
  onChange: () => void;
  navigate: (to: Route) => void;
}) {
  return (
    <section className="flex flex-col">
      <h2 className="m-0 flex items-baseline gap-2 text-[length:var(--text-section)] font-semibold">
        <a
          href={formatRoute({ name: "overview", pid: group.pid })}
          className="text-ink no-underline hover:underline"
        >
          {group.name}
        </a>
        <span className="text-[length:var(--text-row)] font-normal text-ink-muted tabular-nums">
          {group.items.length}
        </span>
      </h2>
      <ul className="m-0 list-none p-0">
        {group.items.map((item) =>
          item.kind === "question" ? (
            <Question
              key={`q/${item.task.projectId}/${item.task.frontmatter.id}`}
              task={item.task}
              onChange={onChange}
            />
          ) : item.kind === "proposed" ? (
            <Proposed
              key={`p/${item.task.frontmatter.id}`}
              task={item.task}
              onChange={onChange}
              navigate={navigate}
            />
          ) : (
            <DraftPlan
              key={`d/${item.plan.id}`}
              pid={group.pid}
              plan={item.plan}
              onChange={onChange}
              navigate={navigate}
            />
          ),
        )}
      </ul>
    </section>
  );
}

/** Everything that needs the user: questions of every project, and the selected one's proposals and drafts. */
export function InboxPage({
  selectedPid,
  data,
  projects,
  navigate,
}: {
  selectedPid: string | null;
  data: AppData;
  projects: { id: string; name: string }[];
  navigate: (to: Route) => void;
}) {
  const needsYou = groupTasks(data.tasks, data.plans).needsYou;
  const groups = inboxGroups(
    data.actions,
    selectedPid ? { pid: selectedPid, needsYou } : null,
    projects,
  );
  const changed = () => void data.refresh();
  return (
    <div className="flex max-w-[1320px] flex-col gap-6">
      <h1 className="m-0 text-[length:var(--text-page)] leading-tight font-semibold">Inbox</h1>
      {groups.length === 0 ? (
        <p className="m-0 text-ink-muted">
          Nothing needs you. Planner questions, proposed tasks and draft plans show up here.
        </p>
      ) : (
        groups.map((g) => <Group key={g.pid} group={g} onChange={changed} navigate={navigate} />)
      )}
    </div>
  );
}
