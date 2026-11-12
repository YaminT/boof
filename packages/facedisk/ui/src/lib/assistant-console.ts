import type { PendingChangeView } from "../api-types.js";
import type { ConsoleLine } from "./console-session.js";

/** What the assistant needs from the console; see `CommandConsole`. */
export interface AssistantAvailability {
  available: boolean;
  reason: string | null;
  noProject: boolean;
}

export const NO_PROJECT_LINE = "Choose a project to ask the assistant.";
export const PLACEHOLDER_COMMAND = "Command, e.g. /queue fix login";
export const PLACEHOLDER_ASSISTANT = "Command or question, e.g. create a task to fix the login";
export const WAITING_HEADER = "Waiting for your review (from earlier):";
export const EARLIER_HEADER = "Changes from earlier in this conversation:";
export const CONFIRM_NOTE = "Proposed by the assistant. It runs with your permissions.";

export function restoredChangesHeader(pending: PendingChangeView[]): string {
  return pending.some((item) => item.status === "pending") ? WAITING_HEADER : EARLIER_HEADER;
}

const FAILURE_WORDS: Record<string, string> = {
  change_stale: "the target changed",
  change_expired: "expired",
  interrupted: "interrupted, check the task",
  change_not_found: "no longer exists",
};

/** Words for a failed row. A raw error code is never shown. */
function failedLabel(code?: string): string {
  if (!code) return "Failed";
  const words = FAILURE_WORDS[code];
  if (words) return `Failed: ${words}`;
  // snake_case tokens are error codes. A sentence is already words.
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(code)) return "Failed";
  return code.startsWith("Failed") ? code : `Failed: ${code}`;
}

export const COMMANDS_HINT = "Commands work: /plan, /activate, /queue, /stop, /open.";
export const DESKTOP_NO_ASSISTANT_LINE = `Plain-words questions need Claude Code installed. ${COMMANDS_HINT}`;

/** The one line shown when the assistant cannot run. */
export function unavailableLine(reason: string | null): string {
  const why = (reason ?? "The assistant is not available.").trim();
  if (/desktop app/i.test(why) || /no assistant harness/i.test(why))
    return DESKTOP_NO_ASSISTANT_LINE;
  if (/disabled|turned off/i.test(why) && /setting/i.test(why)) {
    return `The assistant is disabled in settings. ${COMMANDS_HINT}`;
  }
  const sentence = /[.!?]$/.test(why) ? why : `${why}.`;
  return `Assistant unavailable: ${sentence} ${COMMANDS_HINT}`;
}

export type UnknownPlan = { kind: "ask" } | { kind: "print"; lines: ConsoleLine[] };

/**
 * What to do with input that is not a command. A slash word is always a mistyped command and
 * never goes to the assistant. Unavailable and no-project print and send nothing.
 * `consoleALine` is Console A's own "unknown command" result line.
 */
export function planUnknownInput(
  text: string,
  assistant: AssistantAvailability | undefined,
  consoleALine: ConsoleLine,
): UnknownPlan {
  if (!assistant || text.startsWith("/")) return { kind: "print", lines: [consoleALine] };
  if (assistant.noProject) {
    return { kind: "print", lines: [{ kind: "system", text: NO_PROJECT_LINE }] };
  }
  if (!assistant.available) {
    return {
      kind: "print",
      lines: [{ kind: "system", text: unavailableLine(assistant.reason) }, consoleALine],
    };
  }
  return { kind: "ask" };
}

/** A console row in the order shown: Console A's own rows are placed after `at` assistant rows. */
export type LocalLine = ConsoleLine & { at: number };

/** Interleave the console's own rows with the assistant's. `at` past the end means "at the end". */
export function mergeLines(local: LocalLine[], assistant: ConsoleLine[]): ConsoleLine[] {
  const out: ConsoleLine[] = [];
  let next = 0;
  const flush = (upTo: number) => {
    while (next < local.length && local[next]!.at <= upTo) {
      const { at: _at, ...line } = local[next]!;
      out.push(line);
      next += 1;
    }
  };
  flush(0);
  assistant.forEach((line, i) => {
    out.push(line.kind === "input" ? { ...line, text: `> ${line.text}` } : line);
    flush(i + 1);
  });
  flush(Number.POSITIVE_INFINITY);
  return out;
}

export type RowView =
  { kind: "waiting"; change: PendingChangeView | null } | { kind: "done"; label: string };

/** One pending row: waiting for the user, or what became of it. Expiry is judged by the clock here
 * and by the server on apply. */
export function changeRowView(
  line: ConsoleLine,
  pending: PendingChangeView[],
  now: number,
): RowView {
  if (line.state === "applied") return { kind: "done", label: "Applied" };
  if (line.state === "discarded") return { kind: "done", label: "Discarded" };
  if (line.state === "expired") return { kind: "done", label: "Expired" };
  if (line.state === "failed") {
    return { kind: "done", label: failedLabel(line.detail) };
  }
  const change = pending.find((c) => c.id === line.changeId) ?? null;
  if (change) {
    if (change.status === "applying") return { kind: "done", label: "Applying…" };
    if (change.status === "applied") return { kind: "done", label: "Applied" };
    if (change.status === "discarded") return { kind: "done", label: "Discarded" };
    if (change.status === "failed") {
      return { kind: "done", label: failedLabel(change.error) };
    }
    if (change.status === "expired" || Date.parse(change.expiresAt) <= now) {
      return { kind: "done", label: "Expired" };
    }
  }
  // A row the server no longer lists has nothing to review or discard.
  if (!change) return { kind: "done", label: "No longer waiting" };
  return { kind: "waiting", change };
}

/** Clear plain text for the refusals the server gives before any model call. */
export function refusalText(code: string, message: string): string {
  switch (code) {
    case "concierge_busy":
      return "The assistant is still answering your last message. Wait for it, or press Stop.";
    case "rate_limited":
      return "You are sending messages too fast. Wait a minute and try again.";
    case "concierge_limit":
      return "This conversation reached its cost limit. Type /new to start a new one.";
    case "budget_exceeded":
      return "A daily budget that covers the assistant is used up. Raise it under Settings, Budgets, or wait for the reset.";
    default:
      return message;
  }
}

/** The line for a turn that ended on a cap, or null when it ended normally. */
export function stopReasonText(reason: "done" | "max_turns" | "max_budget"): string | null {
  if (reason === "max_budget") {
    return "The assistant stopped: this message reached its cost limit. Ask again more narrowly, or type /new.";
  }
  if (reason === "max_turns") {
    return "The assistant stopped: it reached the step limit for one message. Ask again to continue.";
  }
  return null;
}

/**
 * Run the user's confirmation. The dialog stays open on a failure and shows its message; it
 * closes only when the change was applied. A second press while one is running does nothing.
 */
export async function runConfirm(
  apply: () => Promise<void>,
  ui: {
    running(): boolean;
    setRunning(on: boolean): void;
    setError(message: string | null): void;
    close(): void;
  },
): Promise<void> {
  if (ui.running()) return;
  ui.setRunning(true);
  ui.setError(null);
  try {
    await apply();
    ui.close();
  } catch (err) {
    ui.setError(err instanceof Error ? err.message : String(err));
  } finally {
    ui.setRunning(false);
  }
}

/** A destructive change gets a red "Confirm"; every other change gets "Apply". */
export function confirmButton(change: Pick<PendingChangeView, "destructive" | "blocked">): {
  label: "Confirm" | "Apply";
  variant: "destructive" | "default";
} | null {
  // A change the operation will refuse has nothing to confirm: only Discard and Close.
  if (change.blocked) return null;
  return change.destructive
    ? { label: "Confirm", variant: "destructive" }
    : { label: "Apply", variant: "default" };
}
