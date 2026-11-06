import { TonePill } from "../shell/StatusPill.js";
import { splitRounds, verdictLabel, verdictTone } from "../lib/report-rounds.js";
import type { TaskView } from "../api.js";

const ROLES = ["planner", "developer", "observer", "reviewer"] as const;

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** One block per role that has a report, newest round first, the verdict line on top. */
export function ReportList({ task }: { task: TaskView }) {
  const blocks = ROLES.flatMap((role) =>
    splitRounds(task.body.reports[role]).map((b, i) => ({ role, b, key: `${role}-${i}` })),
  );
  if (blocks.length === 0) return null;
  return (
    <div className="flex flex-col gap-4">
      {blocks.map(({ role, b, key }) => (
        <article key={key} className="rounded-lg border border-line bg-surface p-4">
          <h3 className="m-0 flex flex-wrap items-center gap-2 text-[length:var(--text-body)] font-semibold">
            {b.round === null
              ? cap(role)
              : `${cap(role)}, round ${b.round}${b.iteration > 1 ? `, run ${b.iteration}` : ""}`}
            {b.verdict && (
              <TonePill tone={verdictTone(b.verdict)}>{verdictLabel(b.verdict)}</TonePill>
            )}
          </h3>
          {b.text && (
            <div className="mt-2 max-w-[80ch] text-[length:var(--text-body)] break-words whitespace-pre-wrap">
              {b.text}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
