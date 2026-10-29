import type { TaskView } from "../api.js";
import { formatRoute } from "../lib/route.js";
import { relativeTime } from "../lib/time.js";
import { StatusPill } from "../shell/StatusPill.js";

/** The latest finished tasks, newest first. */
export function RecentList({ pid, recent }: { pid: string; recent: TaskView[] }) {
  return (
    <div>
      {recent.length === 0 ? (
        <p className="m-0 text-[length:var(--text-row)] text-ink-muted">
          Nothing has finished yet.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {recent.map((t) => {
            const f = t.frontmatter;
            return (
              <li
                key={f.id}
                className="flex items-center gap-3 border-b border-line py-2 text-[length:var(--text-row)] last:border-b-0"
              >
                <StatusPill status={f.status} className="w-[4.5rem] shrink-0 justify-center" />
                <a
                  href={formatRoute({ name: "task", pid, taskId: f.id, view: "edit" })}
                  className="min-w-0 flex-1 truncate text-ink no-underline hover:underline"
                >
                  {f.title}
                </a>
                <span className="shrink-0 text-right text-[length:var(--text-meta)] text-ink-muted">
                  {relativeTime(f.updated)}
                </span>
                <span className="w-[6.5rem] shrink-0 text-right">
                  {f.status === "done" && (
                    <a href={formatRoute({ name: "task", pid, taskId: f.id, view: "changes" })}>
                      Open changes
                    </a>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <a
        href={formatRoute({ name: "tasks", pid })}
        className="mt-2 inline-block text-[length:var(--text-row)]"
      >
        All tasks
      </a>
    </div>
  );
}
