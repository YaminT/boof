import { useEffect } from "react";
import { connectEventStream } from "./sse.js";
import { authHeaders, notifyUnauthorized } from "./token.js";

/**
 * Subscribe to the server's SSE stream and invoke `onChange` on each ping. SSE
 * is a hint: the callback re-fetches fresh data. The stream is read with fetch
 * (not EventSource) so the API key travels in a header, and reconnects with
 * backoff; after a reconnect the callback runs once to catch up on missed pings.
 */
export function useLive(onChange: () => void): void {
  useEffect(() => {
    let opened = false;
    return connectEventStream({
      url: "/api/events",
      headers: authHeaders,
      onMessage: (m) => {
        if (m.event === "changed") onChange();
      },
      onOpen: () => {
        if (opened) onChange();
        opened = true;
      },
      onUnauthorized: notifyUnauthorized,
    });
  }, [onChange]);
}
