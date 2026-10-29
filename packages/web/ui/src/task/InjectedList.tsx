import type { TaskView } from "../api.js";
import { parseInjected } from "../lib/injected.js";
import { relativeTime } from "../lib/time.js";

/** The prompts steered into this task: who, when, at which point, and whether the agent got them. */
export function InjectedList({ task }: { task: TaskView }) {
  const entries = parseInjected(task.body.injected ?? "");
  if (entries.length === 0) return null;
  return (
    <section aria-labelledby="injected-title" className="flex flex-col gap-2">
      <h3 id="injected-title" className="m-0 text-[length:var(--text-body)] font-semibold">
        Injected prompts
      </h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {entries.map((e) => (
          <li
            key={`${e.at}-${e.by}`}
            className="rounded-lg border border-line bg-surface p-3 text-[length:var(--text-body)]"
          >
            <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-[length:var(--text-row)] text-ink-muted">
              <span className="font-medium text-ink">{e.by}</span>
              <time dateTime={e.at} title={e.at}>
                {relativeTime(e.at)}
              </time>
              <span>{e.mode === "now" ? "now" : "at next step"}</span>
              <span>
                {e.appliedAt ? (
                  <>
                    applied <time dateTime={e.appliedAt}>{relativeTime(e.appliedAt)}</time>
                  </>
                ) : (
                  "not applied yet"
                )}
              </span>
            </p>
            <div className="mt-1 max-w-[80ch] break-words whitespace-pre-wrap">{e.text}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
