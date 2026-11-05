/**
 * "Agent SDK: allowed" or "Agent SDK: not allowed (why)" for one gateway account. The words carry
 * the meaning; the colour only helps. Same fill and border scheme as the status pills.
 */
export function AgentSdkBadge({ badge }: { badge: { allowed: boolean; text: string } | null }) {
  if (!badge) return null;
  return (
    <span
      data-testid="agent-sdk-badge"
      className={`inline-flex items-center rounded-full border bg-surface px-2 py-0.5 text-[length:var(--text-meta)] leading-4 font-medium whitespace-nowrap ${
        badge.allowed ? "border-done/40 text-done" : "border-attention/40 text-attention"
      }`}
    >
      {badge.text}
    </span>
  );
}

/** The line above the account list: whether claude-agent may use this gateway, and why. */
export function AgentSdkSummaryLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p data-testid="agent-sdk-summary" className="mt-0 mb-3 text-sm text-ink-muted">
      {text}
    </p>
  );
}
