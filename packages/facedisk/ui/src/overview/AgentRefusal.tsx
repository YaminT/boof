/** Why queued claude-agent tasks do not start: the reason of `runner.status.agentAuth`. */
export function AgentRefusal({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <div
      role="status"
      data-testid="agent-refusal"
      className="rounded-md border border-attention/40 bg-surface p-3 text-[length:var(--text-row)]"
    >
      <p className="m-0 font-medium text-attention">Queued claude-agent tasks are waiting</p>
      <p className="mt-1 mb-0 text-ink">{reason}</p>
    </div>
  );
}
