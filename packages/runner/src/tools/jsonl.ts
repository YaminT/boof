/** Strip ANSI escape sequences (colors, cursor moves, OSC) from CLI output. */
export function stripAnsi(s: string): string {
  return s.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g,
    "",
  );
}

/** Splits streamed chunks into complete lines; `flush` emits a trailing partial line. */
export class LineSplitter {
  private buf = "";
  constructor(private readonly onLine: (line: string) => void) {}
  push(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this.onLine(line);
    }
  }
  flush(): void {
    if (this.buf) this.onLine(this.buf);
    this.buf = "";
  }
}

/**
 * Parse one output line as a JSON object event. Returns null for anything else
 * (warnings, banners, blank lines) so callers can pass those through untouched.
 */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v: unknown = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Render a JSONL stream into readable text. `render` maps an event to text
 * (or "" to skip it); non-JSON lines pass through with ANSI stripped. Each
 * emitted piece ends with a newline.
 */
export class JsonlRenderer {
  private readonly splitter: LineSplitter;
  text = "";
  constructor(
    render: (ev: Record<string, unknown>) => string,
    private readonly sink?: (s: string) => void,
  ) {
    this.splitter = new LineSplitter((line) => {
      const ev = parseJsonLine(line);
      let out: string;
      if (ev) out = render(ev);
      else out = line.trim() ? stripAnsi(line) : "";
      if (!out) return;
      out = out.endsWith("\n") ? out : out + "\n";
      this.text += out;
      this.sink?.(out);
    });
  }
  push(chunk: string): void {
    this.splitter.push(chunk);
  }
  flush(): void {
    this.splitter.flush();
  }
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function oneLine(s: string, n = 160): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "..." : t;
}
