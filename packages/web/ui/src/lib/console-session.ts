import type { Scope } from "@boof-runner/shared/schema";
import { errorMessage } from "./act.js";
import type { CommandAction } from "./command-actions.js";
import {
  availableActions,
  formatConsoleResult,
  resolveConsoleCommand,
  type ConsoleOutcome,
} from "./console-command.js";

export const HISTORY_MAX = 50;
export const OUTPUT_MAX = 200;

/** Add a line to the command history (oldest first): no blanks, no immediate repeats, bounded. */
export function pushHistory(history: string[], entry: string, max = HISTORY_MAX): string[] {
  const text = entry.trim();
  if (!text || history[history.length - 1] === text) return history;
  return [...history, text].slice(-max);
}

export interface Recall {
  /** Which history entry the input shows, or null when it shows the user's own draft. */
  index: number | null;
  draft: string;
}

/** Arrow-key history: up goes back, down comes forward and ends at what the user had typed. */
export function recall(
  history: string[],
  state: Recall,
  dir: "up" | "down",
  current: string,
): { state: Recall; text: string } {
  if (dir === "up") {
    if (history.length === 0) return { state, text: current };
    const draft = state.index === null ? current : state.draft;
    const index = state.index === null ? history.length - 1 : Math.max(0, state.index - 1);
    return { state: { index, draft }, text: history[index]! };
  }
  if (state.index === null) return { state, text: current };
  if (state.index >= history.length - 1) {
    return { state: { index: null, draft: state.draft }, text: state.draft };
  }
  const index = state.index + 1;
  return { state: { index, draft: state.draft }, text: history[index]! };
}

export function appendOutput(lines: string[], line: string, max = OUTPUT_MAX): string[] {
  return [...lines, line].slice(-max);
}

/** Resolve what was typed against the actions the key may use, run it, and describe what happened. */
export async function submitConsole(
  input: string,
  actions: CommandAction[],
  held: ReadonlySet<Scope> | "all",
): Promise<{ outcome: ConsoleOutcome; line: string }> {
  const resolved = resolveConsoleCommand(input, availableActions(actions, held));
  let outcome: ConsoleOutcome;
  if (resolved.kind === "unknown") {
    outcome = resolved;
  } else {
    try {
      await resolved.action.run(resolved.args);
      outcome = { kind: "ok", action: resolved.action };
    } catch (err) {
      outcome = { kind: "error", action: resolved.action, message: errorMessage(err) };
    }
  }
  return { outcome, line: formatConsoleResult(outcome) };
}
