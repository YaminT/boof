import type { ConciergeEvent, PendingChangeView } from "../api-types.js";
import { appendOutput, type ConsoleLine } from "./console-session.js";
import { formatRoute } from "./route.js";
import { tasksForEpicHref } from "./task-links.js";

/** What the console shows for one project. Lines are plain text; nothing here is markdown or HTML. */
export interface ConciergeUiState {
  busy: boolean;
  conversationId: string | null;
  lines: ConsoleLine[];
  pending: PendingChangeView[];
  /** Project the change links belong to. Routes need it, and the stream events do not carry it. */
  pid: string | null;
}

export type ConciergeUiEvent =
  | ConciergeEvent
  | { type: "start"; text: string }
  | { type: "applied" | "discarded" | "failed"; changeId: string; message?: string };

export function initialConciergeUi(pid: string | null = null): ConciergeUiState {
  return { busy: false, conversationId: null, lines: [], pending: [], pid };
}

function changeHref(
  pid: string,
  target: { kind: "task" | "plan" | "epic"; id: string } | null,
): string | undefined {
  if (!target) return undefined;
  if (target.kind === "task") {
    return formatRoute({ name: "task", pid, taskId: target.id, view: "edit" });
  }
  if (target.kind === "plan") return formatRoute({ name: "plans", pid, planId: target.id });
  return tasksForEpicHref(pid, target.id);
}

function assistantLine(lines: ConsoleLine[], text: string): ConsoleLine[] {
  const last = lines[lines.length - 1];
  if (last?.kind === "assistant") {
    const next = lines.slice();
    next[next.length - 1] = { kind: "assistant", text: last.text + text };
    return next;
  }
  return appendOutput(lines, { kind: "assistant", text });
}

/** Fold one concierge event into the console. Model text is stored unchanged. */
export function reduceConcierge(state: ConciergeUiState, e: ConciergeUiEvent): ConciergeUiState {
  switch (e.type) {
    case "start":
      return {
        ...state,
        busy: true,
        lines: appendOutput(state.lines, { kind: "input", text: e.text }),
      };
    case "conversation":
      return { ...state, conversationId: e.conversationId };
    case "text":
      return { ...state, lines: assistantLine(state.lines, e.text) };
    case "tool":
      return state;
    case "change": {
      const href = state.pid ? changeHref(state.pid, e.target) : undefined;
      const line: ConsoleLine = {
        kind: "change",
        text: e.summary,
        ...(href ? { href } : {}),
      };
      return { ...state, lines: appendOutput(state.lines, line) };
    }
    case "pending":
      return {
        ...state,
        pending: state.pending.some((item) => item.id === e.change.id)
          ? state.pending
          : [...state.pending, e.change],
        lines: appendOutput(state.lines, {
          kind: "pending",
          text: e.change.title,
          changeId: e.change.id,
        }),
      };
    case "done":
      return {
        ...state,
        busy: false,
        conversationId: e.answer.conversationId,
        pending: e.answer.pending,
      };
    case "error":
      return {
        ...state,
        busy: false,
        lines: appendOutput(state.lines, { kind: "system", text: e.message }),
      };
    case "applied":
    case "discarded":
      return {
        ...state,
        pending: state.pending.filter((item) => item.id !== e.changeId),
        lines: state.lines.map((line) =>
          line.kind === "pending" && line.changeId === e.changeId
            ? { kind: "system", text: line.text }
            : line,
        ),
      };
    case "failed":
      return e.message
        ? { ...state, lines: appendOutput(state.lines, { kind: "system", text: e.message }) }
        : state;
    default: {
      const never: never = e;
      return never;
    }
  }
}
