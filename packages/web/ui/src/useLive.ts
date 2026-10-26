import { useEffect, useRef } from "react";
import { connectEventStream } from "./sse.js";
import { authHeaders, notifyUnauthorized } from "./token.js";

const EVENTS_URL = "/api/v1/events";

/** A typed event from the server (`task.created`, `task.status`, `plan.updated`, ...). */
export interface LiveEvent {
  type: string;
  project?: string;
  task?: string;
  plan?: string;
}

export interface LiveHandlers {
  /** A typed event: refresh only what it names. */
  onEvent?: (event: LiveEvent) => void;
  /** A hint that files of `project` (or the data root) changed without a typed event. */
  onChanged?: (project?: string) => void;
  /** The stream reconnected after a break: events may have been missed. */
  onReconnect?: () => void;
}

function parse<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/**
 * Subscribe to the server's v1 event stream. The stream is read with fetch (not EventSource) so
 * the API key travels in a header, and reconnects with backoff. Typed events say what changed;
 * `changed` hints cover file changes that are not events (a streaming log). After a reconnect
 * `onReconnect` runs once to catch up.
 */
export function useLive(handlers: LiveHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    let opened = false;
    return connectEventStream({
      url: EVENTS_URL,
      headers: authHeaders,
      onMessage: (m) => {
        if (m.event === "ready" || m.event === "ping") return;
        if (m.event === "changed") {
          ref.current.onChanged?.(parse<{ project?: string }>(m.data)?.project);
          return;
        }
        const event = parse<LiveEvent>(m.data);
        if (event) ref.current.onEvent?.(event);
      },
      onOpen: () => {
        if (opened) ref.current.onReconnect?.();
        opened = true;
      },
      onUnauthorized: notifyUnauthorized,
    });
  }, []);
}
