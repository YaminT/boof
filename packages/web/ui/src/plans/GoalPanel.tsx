import { XIcon } from "lucide-react";
import type { Goal } from "../api.js";
import { Button } from "@/ui/button";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="m-0 text-[length:var(--text-body)] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

const List = ({ items }: { items: string[] }) => (
  <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-[length:var(--text-row)]">
    {items.map((x, i) => (
      <li key={i}>{x}</li>
    ))}
  </ul>
);

/** The spec of one goal, read-only: docked on the right on wide screens, in place of the list below. */
export function GoalPanel({ goal, onClose }: { goal: Goal; onClose: () => void }) {
  const s = goal.spec;
  return (
    <aside
      aria-label={`Goal ${goal.title}`}
      className="flex w-full shrink-0 flex-col gap-4 rounded-lg border border-line bg-surface p-4 min-[1024px]:w-[400px]"
    >
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[length:var(--text-section)] leading-tight font-semibold">
            {goal.title}
          </h2>
          <p className="m-0 mt-1 font-mono text-[length:var(--text-meta)] text-ink-muted">
            {goal.id}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close goal" onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </header>
      <Section title="Goal">
        <p className="m-0 text-[length:var(--text-row)]">{s.goal}</p>
      </Section>
      <Section title="Stack">
        <p className="m-0 text-[length:var(--text-row)]">{s.stack}</p>
      </Section>
      <Section title="Do">
        <List items={s.rules.do} />
      </Section>
      {s.rules.dont.length > 0 && (
        <Section title="Don't">
          <List items={s.rules.dont} />
        </Section>
      )}
      <Section title="Tests">
        <p className="m-0 text-[length:var(--text-row)]">
          {s.tests.strategy} ({s.tests.technology})
        </p>
        <code className="font-mono text-[13px] break-words">{s.tests.run}</code>
        {s.tests.coverage && (
          <p className="m-0 text-[length:var(--text-row)] text-ink-muted">{s.tests.coverage}</p>
        )}
      </Section>
      {goal.model && (
        <Section title="Model">
          <p className="m-0 text-[length:var(--text-row)]">{goal.model}</p>
        </Section>
      )}
    </aside>
  );
}
