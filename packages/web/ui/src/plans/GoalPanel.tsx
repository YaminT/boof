import { useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import type { Goal, Plan, TaskView } from "../api.js";
import { Button } from "@/ui/button";
import { dependsOnTitles, goalStatusTone } from "../lib/plan-view.js";
import { formatRoute } from "../lib/route.js";
import { relativeTime } from "../lib/time.js";
import { StatusPill, TonePill } from "../shell/StatusPill.js";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="m-0 text-[length:var(--text-body)] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

const List = ({ items }: { items: string[] }) => (
  <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-[length:var(--text-row)]">
    {items.map((x, i) => (
      <li key={i}>{x}</li>
    ))}
  </ul>
);

const text = "m-0 text-[length:var(--text-row)]";

/**
 * One goal in the side panel: spec, dependencies, history and the linked task. Docked on the
 * right on wide screens, in place of the list below 1024 px.
 */
export function GoalPanel({
  pid,
  plan,
  goal,
  tasks,
  onEdit,
  onSync,
  onClose,
}: {
  pid: string;
  plan: Plan;
  goal: Goal;
  tasks: Map<string, TaskView>;
  onEdit: () => void;
  onSync: () => void;
  onClose: () => void;
}) {
  const s = goal.spec;
  const [earlierOpen, setEarlierOpen] = useState(false);
  const goalHref = (id: string) => formatRoute({ name: "plans", pid, planId: plan.id, goalId: id });
  const taskHref = (id: string, view: "edit" | "changes" = "edit") =>
    formatRoute({ name: "task", pid, taskId: id, view });
  const deps = dependsOnTitles(goal, plan.goals);
  const dependents = plan.goals.filter((g) => g.dependsOn.includes(goal.id));
  const history = [...goal.history].reverse();
  const task = goal.taskId ? tasks.get(goal.taskId) : undefined;
  const earlier = goal.tasks.slice(0, -1);
  const finished = task && ["done", "failed"].includes(task.frontmatter.status);
  return (
    <aside
      aria-label={`Goal ${goal.title}`}
      className="flex w-full shrink-0 flex-col gap-4 rounded-lg border border-line bg-surface p-4 min-[1024px]:w-[400px]"
    >
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[length:var(--text-section)] leading-tight font-semibold">
            {goal.title}
          </h2>
          <p className="m-0 mt-1 font-mono text-[length:var(--text-meta)] text-ink-muted">
            {goal.id}
          </p>
        </div>
        <TonePill tone={goalStatusTone(goal.status)}>{goal.status}</TonePill>
        <Button variant="outline" size="sm" onClick={onEdit}>
          Edit goal
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close goal" onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </header>
      <Section title="Goal">
        <p className={text}>{s.goal}</p>
      </Section>
      <Section title="Stack">
        <p className={text}>{s.stack}</p>
      </Section>
      <Section title="Do">
        <List items={s.rules.do} />
      </Section>
      {s.rules.dont.length > 0 && (
        <Section title="Don't">
          <List items={s.rules.dont} />
        </Section>
      )}
      <Section title="Tests">
        <p className={text}>
          {s.tests.strategy} ({s.tests.technology})
        </p>
        <code className="font-mono text-[13px] break-words">{s.tests.run}</code>
        {s.tests.coverage && <p className={`${text} text-ink-muted`}>{s.tests.coverage}</p>}
      </Section>
      {goal.model && (
        <Section title="Model">
          <p className={text}>{goal.model}</p>
        </Section>
      )}
      <Section title="Depends on">
        {deps.length === 0 ? (
          <p className={`${text} text-ink-muted`}>Nothing.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[length:var(--text-row)]">
            {deps.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                {d.missing ? (
                  <>
                    <span>{d.id}</span>
                    <TonePill tone="failed">missing</TonePill>
                  </>
                ) : (
                  <>
                    <a href={goalHref(d.id)}>{d.title}</a>
                    {d.done && <span className="text-done">done</span>}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Depended on by">
        {dependents.length === 0 ? (
          <p className={`${text} text-ink-muted`}>Nothing.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[length:var(--text-row)]">
            {dependents.map((g) => (
              <li key={g.id}>
                <a href={goalHref(g.id)}>{g.title}</a>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="History">
        {history.length === 0 ? (
          <p className={`${text} text-ink-muted`}>No history yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[length:var(--text-row)]">
            {history.map((h, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <TonePill tone={goalStatusTone(h.status)}>{h.status}</TonePill>
                <span className="min-w-0 flex-1 basis-40">{h.description}</span>
                <span className="text-[length:var(--text-meta)] text-ink-muted">
                  revision {h.revision} · {relativeTime(h.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Task">
        {task ? (
          <div className="flex flex-wrap items-center gap-2 text-[length:var(--text-row)]">
            <StatusPill status={task.frontmatter.status} />
            <a href={taskHref(task.frontmatter.id)} className="min-w-0 flex-1 truncate">
              {task.frontmatter.title}
            </a>
            {finished && <a href={taskHref(task.frontmatter.id, "changes")}>Open changes</a>}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2">
            <p className={`${text} text-ink-muted`}>No task yet. Sync the plan to create one.</p>
            {plan.status === "active" && (
              <Button variant="outline" size="sm" onClick={onSync}>
                Sync
              </Button>
            )}
          </div>
        )}
        {earlier.length > 0 && (
          <div className="flex flex-col gap-1">
            <Button
              variant="ghost"
              size="xs"
              className="self-start"
              aria-expanded={earlierOpen}
              onClick={() => setEarlierOpen((o) => !o)}
            >
              Earlier tasks ({earlier.length})
            </Button>
            {earlierOpen && (
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[length:var(--text-row)]">
                {earlier.map((t) => (
                  <li key={t.taskId} className="flex items-center gap-2">
                    <StatusPill status={t.status} />
                    <a href={taskHref(t.taskId)} className="font-mono text-[13px]">
                      {t.taskId}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Section>
    </aside>
  );
}
