import { FolderOpenIcon, PauseIcon, PlayIcon, PlusIcon } from "lucide-react";
import { cn } from "../lib/utils.js";
import type { CardState, HomeCard } from "../lib/home.js";
import { runningLabel } from "../lib/labels.js";
import { formatRoute } from "../lib/route.js";

const CHIP: Record<CardState, string> = {
  "needs-you": "border-attention/50 bg-attention/15 text-ink",
  blocked: "border-attention/50 bg-attention/15 text-ink",
  running: "border-transparent bg-done text-white dark:text-page",
  paused: "border-line bg-surface text-ink-muted",
  idle: "border-line bg-surface text-ink-muted",
};

const ICON_BUTTON =
  "focus-ring relative z-10 inline-flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-ink hover:bg-accent disabled:opacity-50";

/**
 * One project on Home. The name is the card's link (stretched over the card); the icon buttons sit
 * above it, so no button is nested in a link.
 */
export function ProjectCard({
  card,
  runningTitle,
  paused,
  busy,
  onTogglePause,
}: {
  card: HomeCard;
  /** Title of the first running task, when known. */
  runningTitle: string | null;
  paused: boolean;
  busy: boolean;
  onTogglePause: () => void;
}) {
  const { project } = card;
  const overview = formatRoute({ name: "overview", pid: project.id });
  const newPlan = formatRoute({ name: "wizard", pid: project.id });
  const running = runningLabel(runningTitle, card.running[0]);
  const brief = project.brief?.trim() || project.workingDirectory;
  return (
    <li
      data-testid="project-card"
      data-state={card.state}
      data-project={project.id}
      className="focus-within:ring-ring/50 relative flex min-h-[176px] flex-col gap-2 rounded-[10px] border border-line bg-surface p-4 focus-within:ring-2 hover:border-accent-brand/50"
    >
      <div className="flex items-start gap-2">
        <h3 className="m-0 min-w-0 flex-1 text-[length:var(--text-body)] font-semibold">
          <a
            href={overview}
            className="focus-ring rounded-sm text-ink no-underline after:absolute after:inset-0 after:rounded-[10px] after:content-['']"
          >
            <span className="block truncate">{project.name}</span>
          </a>
        </h3>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[length:var(--text-meta)] font-medium",
            CHIP[card.state],
          )}
        >
          {card.stateLabel}
        </span>
      </div>
      <p className="m-0 truncate text-[length:var(--text-meta)] text-ink-muted" title={brief}>
        {brief}
      </p>
      <div className="mt-1 flex flex-col gap-1">
        <div
          role="progressbar"
          aria-label={`${project.name} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={card.percent}
          aria-valuetext={card.progressText}
          className="h-2 overflow-hidden rounded-full bg-line"
        >
          <div className="h-full rounded-full bg-done" style={{ width: `${card.percent}%` }} />
        </div>
        <div className="flex items-baseline justify-between gap-2 text-[length:var(--text-row)]">
          <span className="text-ink">{card.progressText}</span>
          {card.goalsText && <span className="text-ink-muted tabular-nums">{card.goalsText}</span>}
        </div>
      </div>
      {card.planTitle && (
        <p
          className="m-0 truncate text-[length:var(--text-meta)] text-ink-muted"
          title={card.planTitle}
        >
          Plan: {card.planTitle}
        </p>
      )}
      {card.running.length > 0 && (
        <p
          className="m-0 truncate text-[length:var(--text-row)] text-ink"
          title={running ?? undefined}
        >
          Running now: {running ?? "…"}
          {card.running.length > 1 ? ` (+${card.running.length - 1})` : ""}
        </p>
      )}
      <div className="mt-auto flex items-center gap-2 pt-1">
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-meta)] text-ink-muted">
          {card.activityText ?? "No activity yet"}
        </span>
        <a href={overview} className={ICON_BUTTON} aria-label={`Open ${project.name}`} title="Open">
          <FolderOpenIcon aria-hidden />
        </a>
        <button
          type="button"
          className={ICON_BUTTON}
          disabled={busy || project.archived}
          aria-label={paused ? `Resume ${project.name}` : `Pause ${project.name}`}
          title={paused ? "Resume this project" : "Pause this project"}
          onClick={onTogglePause}
        >
          {paused ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
        </button>
        <a
          href={newPlan}
          className={ICON_BUTTON}
          aria-label={`New plan in ${project.name}`}
          title="New plan"
        >
          <PlusIcon aria-hidden />
        </a>
      </div>
    </li>
  );
}

export function ProjectCardSkeleton() {
  return (
    <li
      aria-hidden
      className="flex min-h-[176px] animate-pulse flex-col gap-3 rounded-[10px] border border-line bg-surface p-4"
    >
      <div className="h-4 w-1/2 rounded bg-line" />
      <div className="h-3 w-3/4 rounded bg-line" />
      <div className="mt-2 h-2 rounded-full bg-line" />
      <div className="h-3 w-1/3 rounded bg-line" />
    </li>
  );
}
