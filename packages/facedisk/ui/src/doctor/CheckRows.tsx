import type { DoctorCheck } from "../api-types.js";
import { fixRoute, hintParts } from "../lib/doctor.js";
import { formatRoute } from "../lib/route.js";

const MARK = { pass: "✓ pass", warn: "! warning", fail: "✗ fail" } as const;
const TONE = { pass: "text-done", warn: "text-attention", fail: "text-attention" } as const;
export const LINK =
  "rounded-sm text-accent-brand underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-brand";

/** The setup checks, one row each. Every mention of a page or setting in a hint is a real link. */
export function CheckRows({ checks, pid }: { checks: readonly DoctorCheck[]; pid: string | null }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {checks.map((c) => {
        const fix = fixRoute(c.fixPage, pid);
        const parts = c.fixHint ? hintParts(c.fixHint, c.fixPage, pid) : [];
        const hintLinked = parts.some((p) => p.route);
        return (
          <li
            key={c.id}
            data-testid={`check-${c.id}`}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[length:var(--text-row)]"
          >
            <strong className="text-[length:var(--text-body)]">{c.label}</strong>
            <span className={`font-medium ${TONE[c.status]}`}>{MARK[c.status]}</span>
            <span className="text-ink-muted">{c.message}</span>
            {c.status !== "pass" && (parts.length > 0 || fix) && (
              <span className="basis-full text-[length:var(--text-meta)]">
                {parts.map((p, i) =>
                  p.route ? (
                    <a key={i} href={formatRoute(p.route)} className={LINK}>
                      {p.text}
                    </a>
                  ) : (
                    <span key={i}>{p.text}</span>
                  ),
                )}
                {fix && !hintLinked && (
                  <>
                    {parts.length ? " " : ""}
                    <a href={formatRoute(fix)} className={LINK}>
                      Open Settings
                    </a>
                  </>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
