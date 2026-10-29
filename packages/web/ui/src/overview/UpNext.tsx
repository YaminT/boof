import type { TaskView } from "../api.js";
import { formatRoute } from "../lib/route.js";

/** The next three queued tasks in run order. */
export function UpNext({ pid, queued }: { pid: string; queued: TaskView[] }) {
  if (queued.length === 0) {
    return <p className="m-0 text-[length:var(--text-row)] text-ink-muted">Nothing is queued.</p>;
  }
  const more = queued.length - 3;
  return (
    <div>
      <ul className="m-0 list-none p-0">
        {queued.slice(0, 3).map((t) => (
          <li
            key={t.frontmatter.id}
            className="flex items-baseline gap-2 border-b border-line py-2 text-[length:var(--text-row)] last:border-b-0"
          >
            <a
              href={formatRoute({ name: "task", pid, taskId: t.frontmatter.id, view: "edit" })}
              className="min-w-0 flex-1 truncate text-ink no-underline hover:underline"
            >
              {t.frontmatter.title}
            </a>
            <span className="text-right text-ink-muted tabular-nums">
              p{t.frontmatter.priority}
            </span>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <a
          href={formatRoute({ name: "tasks", pid })}
          className="mt-2 inline-block text-[length:var(--text-row)]"
        >
          +{more} more
        </a>
      )}
    </div>
  );
}
