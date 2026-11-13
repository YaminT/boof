import { useEffect, useRef } from "react";
import { invalidateLiveData } from "./lib/request-cache.js";
import { connectEventStream } from "./sse.js";
import { authHeaders, getToken, notifyUnauthorized, onTokenChange } from "./token.js";

const EVENTS_URL = "api/v1/events"; // relative: works at / and behind a path prefix

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
  /** The stream went up (true) or down (false). Called on change only. */
  onStatus?: (up: boolean) => void;
}

function parse<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

// One event stream per tab, shared by every subscriber. It opens with the first subscriber and
// closes with the last.
const subscribers = new Set<{ current: LiveHandlers }>();
let stop: (() => void) | null = null;
let up = false;

function each(fn: (h: LiveHandlers) => void): void {
  for (const s of [...subscribers]) fn(s.current);
}

function setUp(next: boolean): void {
  if (up === next) return;
  up = next;
  each((h) => h.onStatus?.(next));
}

function start(): () => void {
  let opened = false;
  // The key the running stream was opened with: its "unauthorized" event is about that key.
  let streamKey: string | undefined;
  return connectEventStream({
    url: EVENTS_URL,
    headers: () => {
      streamKey = getToken();
      return authHeaders();
    },
    onMessage: (m) => {
      if (m.event === "unauthorized") {
        // The key (or, with none stored, the browser session) stopped working: open the gate.
        notifyUnauthorized(streamKey, streamKey ? "key" : "signin");
        return;
      }
      if (m.event === "ready" || m.event === "ping") return;
      if (m.event === "changed") {
        invalidateLiveData();
        const project = parse<{ project?: string }>(m.data)?.project;
        each((h) => h.onChanged?.(project));
        return;
      }
      const event = parse<LiveEvent>(m.data);
      if (event) {
        invalidateLiveData();
        each((h) => h.onEvent?.(event));
      }
    },
    onOpen: () => {
      invalidateLiveData();
      setUp(true);
      if (opened) each((h) => h.onReconnect?.());
      opened = true;
    },
    onClose: () => setUp(false),
    onUnauthorized: (sent, reason) => notifyUnauthorized(sent, reason),
    waitForCredentials: (signal) =>
      new Promise((resolve) => {
        const done = () => {
          off();
          signal.removeEventListener("abort", done);
          resolve();
        };
        const off = onTokenChange(done);
        signal.addEventListener("abort", done, { once: true });
      }),
  });
}

/**
 * Subscribe to the server's v1 event stream (shared by the whole tab). The stream is read with
 * fetch (not EventSource) so the API key travels in a header, and reconnects with backoff. Typed
 * events say what changed; `changed` hints cover file changes that are not events (a streaming
 * log). After a reconnect `onReconnect` runs once to catch up. Cached reads that an event may have
 * changed are dropped before handlers run.
 */
export function useLive(handlers: LiveHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    subscribers.add(ref);
    if (up) ref.current.onStatus?.(true);
    if (!stop) stop = start();
    return () => {
      subscribers.delete(ref);
      if (subscribers.size === 0 && stop) {
        stop();
        stop = null;
        up = false;
      }
    };
  }, []);
}
