/**
 * Passive usage reader for one upstream response. Fed every chunk after it was forwarded; it
 * never throws, never delays the stream and keeps no text beyond one partial SSE line (or a
 * bounded JSON body). Junk events are skipped, not fatal.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

const MAX_LINE = 256 * 1024;
const MAX_JSON = 4 * 1024 * 1024;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;

/** Total input = fresh + cache-creation + cache-read tokens (the docs' total_input_tokens). */
function readUsage(u: unknown): { input?: number; output?: number } {
  if (!u || typeof u !== "object") return {};
  const r = u as Record<string, unknown>;
  const parts = [r.input_tokens, r.cache_creation_input_tokens, r.cache_read_input_tokens]
    .map(num)
    .filter((n): n is number => n !== undefined);
  return {
    input:
      parts.length && num(r.input_tokens) !== undefined
        ? parts.reduce((a, b) => a + b, 0)
        : undefined,
    output: num(r.output_tokens),
  };
}

export class UsageTap {
  private readonly sse: boolean;
  private input = 0;
  private output = 0;
  private seen = false;
  private buf = "";
  private skipping = false;
  private json: Buffer[] = [];
  private jsonSize = 0;
  private jsonDropped = false;

  constructor(contentType: string | undefined) {
    this.sse = (contentType ?? "").toLowerCase().includes("text/event-stream");
  }

  write(chunk: Buffer | string): void {
    try {
      if (this.sse) this.writeSse(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      else this.writeJson(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    } catch {
      // A tap must never break the stream.
    }
  }

  /** The counted usage, or undefined when none was seen. */
  end(): Usage | undefined {
    try {
      if (this.sse) {
        if (this.buf && !this.skipping) this.line(this.buf);
        this.buf = "";
      } else if (!this.jsonDropped && this.jsonSize > 0) {
        const body = JSON.parse(Buffer.concat(this.json).toString("utf8")) as { usage?: unknown };
        this.take(readUsage(body.usage));
      }
    } catch {
      // junk body: report what was seen, if anything
    }
    return this.seen ? { inputTokens: this.input, outputTokens: this.output } : undefined;
  }

  private take(u: { input?: number; output?: number }): void {
    if (u.input !== undefined) {
      this.input = u.input;
      this.seen = true;
    }
    if (u.output !== undefined) {
      this.output = u.output;
      this.seen = true;
    }
  }

  private writeJson(chunk: Buffer): void {
    if (this.jsonDropped) return;
    this.jsonSize += chunk.length;
    if (this.jsonSize > MAX_JSON) {
      this.jsonDropped = true;
      this.json = [];
      return;
    }
    this.json.push(chunk);
  }

  private writeSse(text: string): void {
    this.buf += text;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const raw = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (this.skipping) this.skipping = false;
      else this.line(raw);
    }
    if (this.buf.length > MAX_LINE) {
      this.buf = "";
      this.skipping = true;
    }
  }

  private line(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data[0] !== "{") return;
    let ev: { type?: unknown; message?: { usage?: unknown }; usage?: unknown };
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    if (ev.type === "message_start") this.take(readUsage(ev.message?.usage));
    else if (ev.type === "message_delta") this.take(readUsage(ev.usage));
  }
}
