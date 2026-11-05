import type { AgentAuthEntry } from "../api-types.js";
import { agentAuthLine } from "../lib/claude-agent.js";

/**
 * The explanation under a role that uses claude-agent. `kind: "auth"` is the compliance note plus
 * the live line from `runner.status.agentAuth`; `kind: "unavailable"` is the fixed note for a tool
 * this install cannot run (the desktop app). No hooks: the page passes in what it loaded.
 */
export function ClaudeAgentNote({
  kind,
  text,
  auth,
  checked = true,
}: {
  kind: "auth" | "unavailable";
  text: string;
  /** This project's entry of `runner.status.agentAuth`, when there is one. */
  auth?: AgentAuthEntry;
  /** False while the live line is still loading. */
  checked?: boolean;
}) {
  const line = kind === "auth" ? agentAuthLine(auth) : null;
  return (
    <div
      role="note"
      data-testid="claude-agent-note"
      className="mt-3 flex max-w-[720px] flex-col gap-2 rounded-md border border-line bg-surface p-3 text-[length:var(--text-row)]"
    >
      <p className="m-0 text-ink">{text}</p>
      {kind === "auth" &&
        (line ? (
          <p
            data-testid="claude-agent-live"
            className={`m-0 font-medium ${auth?.allowed ? "text-done" : "text-attention"}`}
          >
            {line}
          </p>
        ) : (
          <p className="m-0 text-ink-muted">
            {checked
              ? "Save these roles to check whether claude-agent can start for this project."
              : "Checking…"}
          </p>
        ))}
    </div>
  );
}
