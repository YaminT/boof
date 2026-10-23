import { useEffect } from "react";
import { connectEventStream } from "./sse.js";
import { authHeaders, notifyUnauthorized } from "./token.js";

/** The project id carried by a `changed` event, if any (`{project}` or `{}`). */
function changedProject(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data) as { project?: unknown } | null;
    return typeof parsed?.project === "string" ? parsed.project : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Subscribe to the server's SSE stream and invoke `onChange(project?)` on each ping. SSE
 * is a hint: the callback re-fetches fresh data. The stream is read with fetch
 * (not EventSource) so the API key travels in a header, and reconnects with
 * backoff; after a reconnect the callback runs once to catch up on missed pings.
 */
export function useLive(onChange: (project?: string) => void): void {
  useEffect(() => {
    let opened = false;
    return connectEventStream({
      url: "/api/events",
      headers: authHeaders,
      onMessage: (m) => {
        if (m.event === "changed") onChange(changedProject(m.data));
      },
      onOpen: () => {
        if (opened) onChange();
        opened = true;
      },
      onUnauthorized: notifyUnauthorized,
    });
  }, [onChange]);
}
