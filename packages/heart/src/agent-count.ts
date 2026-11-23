/** The one rule for "how many coding agents are ready": the Doctor card, `boof doctor` and the server check all use it. */
export function countReadyAgents(tools: Record<string, { ready: boolean }>): number {
  return Object.values(tools).filter((t) => t.ready).length;
}

/** "1 agent ready" / "2 agents ready". */
export function agentsReadyText(tools: Record<string, { ready: boolean }>): string {
  const n = countReadyAgents(tools);
  return `${n} agent${n === 1 ? "" : "s"} ready`;
}
