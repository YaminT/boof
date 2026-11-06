import type { ConciergeEvent, PendingChangeView } from "../api-types.js";
import { appendOutput, type ConsoleLine } from "./console-session.js";
import { refusalText, stopReasonText } from "./assistant-console.js";
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
  | { type: "applied" | "discarded"; changeId: string }
  | {
      type: "failed";
      changeId: string;
      message?: string;
      /** The server judged and refused the change: the row is final. A network error is not. */
      final?: boolean;
      code?: string;
    };

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

/** The row keeps its place and shows what became of the change; it can no longer be applied. */
function settle(
  state: ConciergeUiState,
  changeId: string,
  to: "applied" | "discarded" | "failed" | "expired",
  detail?: string,
): ConciergeUiState {
  return {
    ...state,
    pending: state.pending.filter((item) => item.id !== changeId),
    lines: state.lines.map((line) =>
      line.kind === "pending" && line.changeId === changeId
        ? { ...line, state: to, ...(detail && to === "failed" ? { detail } : {}) }
        : line,
    ),
  };
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
    case "done": {
      const stop = stopReasonText(e.answer.stopReason);
      return {
        ...state,
        busy: false,
        conversationId: e.answer.conversationId,
        pending: e.answer.pending,
        lines: stop ? appendOutput(state.lines, { kind: "system", text: stop }) : state.lines,
      };
    }
    case "error":
      return {
        ...state,
        busy: false,
        lines: appendOutput(state.lines, {
          kind: "system",
          text: refusalText(e.code, e.message),
        }),
      };
    case "applied":
    case "discarded":
      return settle(state, e.changeId, e.type);
    case "failed": {
      const next = e.final
        ? settle(state, e.changeId, e.code === "change_expired" ? "expired" : "failed", e.message)
        : state;
      return e.message
        ? { ...next, lines: appendOutput(next.lines, { kind: "system", text: e.message }) }
        : next;
    }
    default: {
      const never: never = e;
      return never;
    }
  }
}
