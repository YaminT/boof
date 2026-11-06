import type { ReactNode } from "react";

/** A heading with its count and an optional hint, over a list of rows. */
export function TaskSection({
  title,
  count,
  hint,
  children,
}: {
  title: string;
  count?: number;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-6">
      <h2 className="mt-0 mb-1 flex flex-wrap items-baseline gap-x-3 text-[length:var(--text-section)]">
        <span>
          {title}
          {count !== undefined && (
            <span className="ml-2 font-normal text-ink-muted tabular-nums">{count}</span>
          )}
        </span>
        {hint && (
          <span className="text-[length:var(--text-meta)] font-normal text-ink-muted">{hint}</span>
        )}
      </h2>
      {children}
    </section>
  );
}
