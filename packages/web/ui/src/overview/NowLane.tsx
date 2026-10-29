import { Button } from "@/ui/button";
import type { Settings } from "@boof-runner/shared/schema";
import type { Route } from "../lib/route.js";
import type { TaskGroups } from "../lib/task-groups.js";
import { toggleRunner } from "../shell/RunnerSwitch.js";
import { NeedsYouList } from "./NeedsYouList.js";
import { RunningCard } from "./RunningCard.js";
import { UpNext } from "./UpNext.js";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <h3 className="mt-0 mb-1 text-[length:var(--text-body)] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** What is running now (left) and what waits on the user or comes next (right). */
export function NowLane({
  pid,
  projectPaused,
  groups,
  settings,
  navigate,
  onChange,
}: {
  pid: string;
  projectPaused: boolean;
  groups: TaskGroups;
  settings: Settings | null;
  navigate: (to: Route) => void;
  onChange: () => void | Promise<void>;
}) {
  const paused = settings ? !settings.runner.enabled : false;
  const queueEmpty = groups.queued.length === 0;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
        {groups.running.length > 0 ? (
          groups.running.map((t) => (
            <RunningCard
              key={t.frontmatter.id}
              pid={pid}
              task={t}
              onChange={() => void onChange()}
            />
          ))
        ) : (
          <section className="rounded-lg border border-line bg-surface p-4">
            <p className="m-0 text-[length:var(--text-body)] font-medium">Nothing running.</p>
            {projectPaused ? (
              <p className="mt-1 mb-0 text-[length:var(--text-row)] text-ink-muted">
                This project is paused. Its queued tasks wait until you resume it.
              </p>
            ) : queueEmpty ? (
              <>
                <p className="mt-1 mb-3 text-[length:var(--text-row)] text-ink-muted">
                  Queue is empty. Add a task or let a harness submit a plan.
                </p>
                <Button
                  onClick={() => navigate({ name: "task", pid, taskId: "__new__", view: "edit" })}
                >
                  New task
                </Button>
              </>
            ) : paused ? (
              <>
                <p className="mt-1 mb-3 text-[length:var(--text-row)] text-ink-muted">
                  The runner is paused. Turn it on to start the next queued task.
                </p>
                <Button onClick={() => void toggleRunner(false).then(onChange)}>
                  Turn runner on
                </Button>
              </>
            ) : null}
          </section>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Section title="Needs you">
          <NeedsYouList
            pid={pid}
            items={groups.needsYou}
            navigate={navigate}
            onChange={() => void onChange()}
          />
        </Section>
        <Section title="Up next">
          <UpNext pid={pid} queued={groups.queued} />
        </Section>
      </div>
    </div>
  );
}
