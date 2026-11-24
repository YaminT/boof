/** The start-up line about the runner; it must not say "started" while the runner is paused. */
export function runnerBanner(i: {
  engine: boolean;
  enabled: boolean;
  noRunner: boolean;
}): string | null {
  if (i.engine)
    return i.enabled
      ? "Runner:  started (toggle on/off in the UI)"
      : "Runner:  ready but paused (turn it on in the UI)";
  if (!i.noRunner) return "Runner:  already running in another process — not starting a second one";
  return null;
}
