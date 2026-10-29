// fetch-based Server-Sent Events reader. EventSource cannot send headers, so the
// API key would have to travel in the URL; this keeps it in an Authorization header.

export interface SseMessage {
  event: string;
  data: string;
}

/** Incremental parser for the text/event-stream wire format. */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];

  /** Feed a decoded chunk; returns the complete messages it finished. */
  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let nl: number;
    while ((nl = this.buffer.search(/\r\n|\n|\r/)) !== -1) {
      const m = /^(\r\n|\n|\r)/.exec(this.buffer.slice(nl));
      const sepLen = m ? m[0].length : 1;
      // A trailing bare "\r" may be the first half of "\r\n"; wait for more input.
      if (this.buffer[nl] === "\r" && nl + 1 === this.buffer.length) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + sepLen);
      if (line === "") {
        if (this.data.length > 0 || this.event) {
          out.push({ event: this.event || "message", data: this.data.join("\n") });
        }
        this.event = "";
        this.data = [];
      } else if (line.startsWith(":")) {
        // comment / keep-alive
      } else {
        const i = line.indexOf(":");
        const field = i === -1 ? line : line.slice(0, i);
        let value = i === -1 ? "" : line.slice(i + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") this.event = value;
        else if (field === "data") this.data.push(value);
      }
    }
    return out;
  }
}

/** Read a stream to completion, calling `onMessage` for every event. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onMessage: (m: SseMessage) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const m of parser.push(decoder.decode(value, { stream: true }))) onMessage(m);
    }
  } finally {
    reader.releaseLock();
  }
}

export interface EventStreamOptions {
  url: string;
  headers: () => Record<string, string>;
  onMessage: (m: SseMessage) => void;
  /** Called after each (re)connection becomes ready, e.g. to refetch. */
  onOpen?: () => void;
  /** Called on a 401 so the UI can ask for a key; reconnects stop until the next start(). */
  onUnauthorized?: () => void;
  /**
   * Resolves when new credentials are available (or `signal` aborts). When set, a 401 pauses the
   * stream instead of ending it, so live updates resume after the user enters a key.
   */
  waitForCredentials?: (signal: AbortSignal) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** Reconnect delay for the nth consecutive failure (default: 1s doubling to 30s). */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultBackoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Connect and keep reconnecting with backoff until the returned function is
 * called. A clean end-of-stream also reconnects (the server may restart).
 */
export function connectEventStream(opts: EventStreamOptions): () => void {
  const ctrl = new AbortController();
  const doFetch = opts.fetchImpl ?? fetch;
  const backoff = opts.backoffMs ?? defaultBackoff;
  const sleep = opts.sleep ?? defaultSleep;

  void (async () => {
    let attempt = 0;
    while (!ctrl.signal.aborted) {
      try {
        const res = await doFetch(opts.url, {
          headers: { accept: "text/event-stream", ...opts.headers() },
          signal: ctrl.signal,
        });
        if (res.status === 401) {
          opts.onUnauthorized?.();
          // Without a way to wait for a new key, stop; otherwise pause until one is stored.
          if (!opts.waitForCredentials) return;
          await opts.waitForCredentials(ctrl.signal);
          if (ctrl.signal.aborted) return;
          attempt = 0;
          continue;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        attempt = 0;
        opts.onOpen?.();
        await readSse(res.body, opts.onMessage);
      } catch {
        if (ctrl.signal.aborted) return;
      }
      if (ctrl.signal.aborted) return;
      await sleep(backoff(attempt), ctrl.signal);
      attempt += 1;
    }
  })();

  return () => ctrl.abort();
}
