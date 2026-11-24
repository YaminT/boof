import { useEffect, useMemo, useState } from "react";
import type { Project } from "@boof/heart/schema";
import { Input } from "@/ui/input";
import { api } from "../api.js";
import { act } from "../lib/act.js";
import { FILTER_FROM, filterCards, homeCards, summaryOf } from "../lib/home.js";
import { useSharedRunnerOverview } from "../lib/runner-overview-context.js";
import { SetupCheckWidget } from "../doctor/SetupCheckWidget.js";
import type { HarnessesState } from "../useHarnesses.js";
import { ProjectCard, ProjectCardSkeleton } from "./ProjectCard.js";
import { useTaskTitles } from "./useTaskTitles.js";

/**
 * The first page: the Doctor widget, every project with its progress, and a one-line summary. It
 * reads the shared runner overview (no request of its own), so progress arrives with the events
 * the topbar already listens to.
 */
export function HomePage({
  projects,
  selectedId,
  harnesses,
  reloadProjects,
}: {
  projects: Project[] | null;
  selectedId: string | null;
  harnesses: HarnessesState;
  reloadProjects: () => Promise<void>;
}) {
  const runner = useSharedRunnerOverview();
  const overview = runner?.overview ?? null;
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!showArchived) return setArchived([]);
    let live = true;
    api.listProjects(true).then(
      (all) => live && setArchived(all.filter((p) => p.archived)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [showArchived]);

  const all = useMemo(() => [...(projects ?? []), ...archived], [projects, archived]);
  const cards = useMemo(() => homeCards(all, overview), [all, overview]);
  const summary = useMemo(() => summaryOf(cards), [cards]);
  const shown = filterCards(cards, query);
  const titleOf = useTaskTitles(
    shown.flatMap((c) => c.running.slice(0, 1).map((t) => `${c.project.id}/${t}`)),
  );

  const togglePause = async (card: (typeof cards)[number], paused: boolean) => {
    const id = card.project.id;
    setBusy(id);
    await act(() => (paused ? api.resumeProject(id) : api.pauseProject(id)), {
      failure: paused ? "Could not resume the project" : "Could not pause the project",
    });
    await Promise.all([runner?.reload(), reloadProjects().catch(() => undefined)]);
    setBusy(null);
  };

  // Projects come from a fast request; the overview reads every project's folders and can be slow.
  // Cards render as soon as the projects are known, with progress filled in when it arrives.
  const loading = projects === null;
  const progressPending = overview === null && !runner?.denied;
  return (
    <div className="flex flex-col gap-6" data-testid="home">
      <h1 className="m-0">Home</h1>
      <SetupCheckWidget harnesses={harnesses} pid={selectedId} />
      <section aria-labelledby="home-projects" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 id="home-projects" className="m-0 text-[length:var(--text-body)] font-semibold">
            Projects
          </h2>
          <p
            data-testid="home-summary"
            aria-live="polite"
            className="m-0 min-w-0 flex-1 text-[length:var(--text-row)] text-ink-muted"
          >
            {loading || progressPending
              ? "Loading…"
              : `${summary.running} running · ${summary.queued} queued · ${summary.needsYou} need you · ${summary.doneToday} done today`}
          </p>
          {cards.length > FILTER_FROM && (
            <Input
              type="search"
              aria-label="Filter projects"
              placeholder="Filter projects"
              className="h-8 w-56"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <label className="flex items-center gap-2 text-[length:var(--text-row)] text-ink">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
        </div>
        <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 min-[720px]:grid-cols-2 min-[1100px]:grid-cols-3">
          {loading
            ? [0, 1, 2].map((i) => <ProjectCardSkeleton key={i} />)
            : shown.map((card) => {
                const row = overview?.projects.find((p) => p.id === card.project.id);
                const first = card.running[0];
                return (
                  <ProjectCard
                    key={card.project.id}
                    card={card}
                    runningTitle={first ? titleOf(`${card.project.id}/${first}`) : null}
                    paused={row?.paused ?? card.project.paused}
                    progressPending={progressPending}
                    busy={busy === card.project.id}
                    onTogglePause={() => void togglePause(card, row?.paused ?? card.project.paused)}
                  />
                );
              })}
        </ul>
        {!loading && shown.length === 0 && (
          <p className="m-0 text-ink-muted">No project matches “{query}”.</p>
        )}
      </section>
    </div>
  );
}
