import { useMemo } from "react";
import type { Project } from "@boof-runner/shared/schema";
import type { AppData } from "../useAppData.js";
import type { Route } from "../lib/route.js";
import { FocusToggle } from "@/ui/focus-toggle";
import { overviewParts } from "../lib/focus-views.js";
import { spendFor } from "../lib/spend.js";
import { useFocusMode } from "../lib/useFocusMode.js";
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
  const focus = useFocusMode("overview");
  const groups = useMemo(() => groupTasks(data.tasks, data.plans), [data.tasks, data.plans]);
  const parts = overviewParts(
    focus.expanded,
    groups.finished.recent,
    spendFor(data.budget, pid)?.exceeded === true,
  );
  return (
    <div className="flex flex-col gap-6">
      <header>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="m-0 flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-page)] font-semibold">
            {project?.name ?? pid}
            {project?.paused && <TonePill tone="neutral">Paused</TonePill>}
          </h1>
          <FocusToggle mode={focus.mode} onToggle={focus.toggle} />
        </div>
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
      {parts.showRecent && (
        <section className="flex flex-col gap-2">
          <h2 className="m-0 text-[length:var(--text-section)] font-semibold">
            {focus.expanded ? "Recent" : "Needs a look"}
          </h2>
          <RecentList pid={pid} recent={parts.recent} onRetry={actions.retry} />
        </section>
      )}
      {parts.showSpend && <SpendBar budget={data.budget} pid={pid} />}
    </div>
  );
}
