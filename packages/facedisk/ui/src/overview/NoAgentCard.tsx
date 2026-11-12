import { installHelp } from "../lib/harnesses.js";

/** Shown on Overview when no coding agent is installed: what to install. Static text; nothing is fetched. */
export function NoAgentCard() {
  return (
    <section
      role="note"
      data-testid="no-agent-card"
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
    >
      <h2 className="m-0 text-[length:var(--text-section)] font-semibold">No coding agent found</h2>
      <p className="m-0 text-[length:var(--text-row)] text-ink-muted">
        boof runs tasks through a coding agent installed on this computer. Install one, then open
        Settings › Agents and choose Check again.
      </p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[length:var(--text-row)]">
        {installHelp().map((h) => (
          <li key={h.id} className="flex flex-wrap items-center gap-x-2">
            <strong>{h.id}</strong>
            {h.command && <code className="font-mono">{h.command}</code>}
            <a href={h.url} target="_blank" rel="noreferrer" className="text-accent underline">
              install page
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
