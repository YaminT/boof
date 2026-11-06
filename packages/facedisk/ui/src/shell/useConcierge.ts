import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api.js";
import type { ConciergeContext, ConciergeStatus } from "../api-types.js";
import { EARLIER_HEADER, WAITING_HEADER } from "../lib/assistant-console.js";
import { errorMessage } from "../lib/act.js";
import {
  initialConciergeUi,
  reduceConcierge,
  type ConciergeUiState,
} from "../lib/concierge-session.js";

/**
 * Assistant session for one project. Status reloads when the project changes and after each
 * message. `onDataChanged` runs after a draft is written or a pending change is applied, so the
 * caller can refresh tasks and plans. Stream text stays plain text in `state.lines`.
 */
export function useConcierge(
  pid: string | null,
  context: ConciergeContext | null,
  onDataChanged?: () => void,
): {
  status: ConciergeStatus | null;
  ask(text: string): Promise<void>;
  apply(id: string): Promise<void>;
  discard(id: string): Promise<void>;
  reset(): Promise<void>;
  cancel(): void;
  state: ConciergeUiState;
} {
  const [status, setStatus] = useState<ConciergeStatus | null>(null);
  const [state, setState] = useState<ConciergeUiState>(() => initialConciergeUi(pid));
  const abortRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const contextRef = useRef(context);
  const onDataChangedRef = useRef(onDataChanged);
  const conversationRef = useRef<string | null>(null);
  contextRef.current = context;
  onDataChangedRef.current = onDataChanged;

  const refreshStatus = useCallback(async (project: string, gen: number) => {
    try {
      const next = await api.conciergeStatus(project);
      if (generation.current !== gen) return;
      setStatus(next);
      if (next.conversation) conversationRef.current = next.conversation.id;
    } catch {
      // A failed status read leaves the previous status in place.
    }
  }, []);

  useEffect(() => {
    const gen = ++generation.current;
    abortRef.current?.abort();
    abortRef.current = null;
    conversationRef.current = null;
    setStatus(null);
    setState(initialConciergeUi(pid));
    if (!pid) return;
    let cancelled = false;
    void api.conciergeStatus(pid).then(
      (next) => {
        if (cancelled || generation.current !== gen) return;
        setStatus(next);
        const conversation = next.conversation;
        if (!conversation) return;
        conversationRef.current = conversation.id;
        setState((current) => {
          if (current.pid !== pid || current.busy || current.lines.length > 0) {
            return { ...current, conversationId: conversation.id };
          }
          return {
            ...current,
            conversationId: conversation.id,
            pending: conversation.pending,
            lines:
              conversation.pending.length === 0
                ? []
                : [
                    {
                      kind: "system" as const,
                      text: conversation.pending.some((item) => item.status === "pending")
                        ? WAITING_HEADER
                        : EARLIER_HEADER,
                    },
                    ...conversation.pending.map((item) => ({
                      kind: "pending" as const,
                      text: item.title,
                      changeId: item.id,
                    })),
                  ],
          };
        });
      },
      () => {
        if (!cancelled && generation.current === gen) setStatus(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pid]);

  const ask = useCallback(
    async (text: string) => {
      if (!pid) return;
      const gen = generation.current;
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setState((current) => reduceConcierge({ ...current, pid }, { type: "start", text }));
      try {
        await api.conciergeStream(
          pid,
          {
            text,
            ...(contextRef.current ? { context: contextRef.current } : {}),
            ...(conversationRef.current ? { conversationId: conversationRef.current } : {}),
          },
          (event) => {
            if (generation.current !== gen) return;
            if (event.type === "conversation") conversationRef.current = event.conversationId;
            if (event.type === "done") conversationRef.current = event.answer.conversationId;
            if (event.type === "change") onDataChangedRef.current?.();
            setState((current) => reduceConcierge(current, event));
          },
          ctrl.signal,
        );
      } catch (err) {
        if (generation.current !== gen) return;
        if (ctrl.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          setState((current) => (current.busy ? { ...current, busy: false } : current));
        } else {
          setState((current) =>
            reduceConcierge(current, {
              type: "error",
              code: err instanceof ApiError ? (err.code ?? "internal") : "internal",
              message: errorMessage(err),
            }),
          );
        }
      } finally {
        if (generation.current === gen) {
          if (abortRef.current === ctrl) abortRef.current = null;
          setState((current) => (current.busy ? { ...current, busy: false } : current));
          await refreshStatus(pid, gen);
        }
      }
    },
    [pid, refreshStatus],
  );

  const apply = useCallback(
    async (id: string) => {
      if (!pid) return;
      const gen = generation.current;
      try {
        await api.conciergeApply(pid, id);
        if (generation.current !== gen) return;
        setState((current) => reduceConcierge(current, { type: "applied", changeId: id }));
        onDataChangedRef.current?.();
        await refreshStatus(pid, gen);
      } catch (err) {
        if (generation.current === gen) {
          setState((current) =>
            reduceConcierge(current, {
              type: "failed",
              changeId: id,
              message: errorMessage(err),
              final: err instanceof ApiError,
              ...(err instanceof ApiError && err.code ? { code: err.code } : {}),
            }),
          );
        }
        throw err;
      }
    },
    [pid, refreshStatus],
  );

  const discard = useCallback(
    async (id: string) => {
      if (!pid) return;
      const gen = generation.current;
      try {
        await api.conciergeDiscard(pid, id);
        if (generation.current !== gen) return;
        setState((current) => reduceConcierge(current, { type: "discarded", changeId: id }));
        await refreshStatus(pid, gen);
      } catch (err) {
        if (generation.current === gen) {
          setState((current) =>
            reduceConcierge(current, {
              type: "failed",
              changeId: id,
              message: errorMessage(err),
            }),
          );
        }
        throw err;
      }
    },
    [pid, refreshStatus],
  );

  const reset = useCallback(async () => {
    if (!pid) return;
    const gen = generation.current;
    await api.conciergeReset(pid);
    if (generation.current !== gen) return;
    conversationRef.current = null;
    setState(initialConciergeUi(pid));
    await refreshStatus(pid, gen);
  }, [pid, refreshStatus]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState((current) => (current.busy ? { ...current, busy: false } : current));
  }, []);

  return { status, ask, apply, discard, reset, cancel, state };
}
