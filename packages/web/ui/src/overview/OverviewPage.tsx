import { useMemo } from "react";
import type { Project } from "@boof-runner/shared/schema";
import type { AppData } from "../useAppData.js";
import type { Route } from "../lib/route.js";
import { groupTasks } from "../lib/task-groups.js";
import { useTaskActions } from "../tasks/useTaskActions.js";
import { TonePill } from "../shell/StatusPill.js";
import { NowLane } from "./NowLane.js";
import { RecentList } from "./RecentList.js";
import { SpendBar } from "./SpendBar.js";

/** The landing page of a project: what runs, what needs the user and what finished. */
export function OverviewPage({
  pid,
  project,
  data,
  navigate,
}: {
  pid: string;
  project: Project | null;
  data: AppData;
  navigate: (to: Route) => void;
}) {
  const actions = useTaskActions(pid, data, navigate);
  const groups = useMemo(() => groupTasks(data.tasks, data.plans), [data.tasks, data.plans]);
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-page)] font-semibold">
          {project?.name ?? pid}
          {project?.paused && <TonePill tone="neutral">Paused</TonePill>}
        </h1>
        {project?.workingDirectory && (
          <p className="mt-1 mb-0 font-mono text-[length:var(--text-meta)] text-ink-muted">
            {project.workingDirectory}
          </p>
        )}
      </header>
      <section aria-label="Now" className="flex flex-col gap-3">
        <h2 className="m-0 text-[length:var(--text-section)] font-semibold">Now</h2>
        <NowLane
          pid={pid}
          projectPaused={!!project?.paused}
          groups={groups}
          settings={data.settings}
          navigate={navigate}
          onChange={() => data.refresh()}
        />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-[length:var(--text-section)] font-semibold">Recent</h2>
        <RecentList pid={pid} recent={groups.finished.recent} onRetry={actions.retry} />
      </section>
      <SpendBar budget={data.budget} pid={pid} />
    </div>
  );
}
