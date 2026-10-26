// Pure helpers (browser-safe) for the durable `## Injected` task-body section.

/** One prompt injected into a running task. */
export interface InjectedEntry {
  /** ISO-8601 time of the injection. */
  at: string;
  /** Who injected it: a principal name, or "user". */
  by: string;
  text: string;
}

const HEADER = /^### (\d{4}-\d{2}-\d{2}T\S+) — (.*)$/;

/**
 * One markdown entry: a `### <iso> — <by>` heading and the prompt text. A text line that would
 * open a top-level task section (`## Log`, ...) is indented by one space so it cannot split the file.
 */
export function formatInjectedEntry(entry: InjectedEntry): string {
  const by = entry.by.replace(/[\r\n]+/g, " ").trim() || "user";
  const text = entry.text
    .trim()
    .split("\n")
    .map((l) => (l.startsWith("## ") ? ` ${l}` : l))
    .join("\n");
  return `### ${entry.at} — ${by}\n\n${text}`;
}

/** Parse the section body into entries; text before the first heading is ignored. */
export function parseInjected(md: string): InjectedEntry[] {
  const out: InjectedEntry[] = [];
  let cur: { at: string; by: string; lines: string[] } | null = null;
  const flush = () => {
    if (cur) out.push({ at: cur.at, by: cur.by, text: cur.lines.join("\n").trim() });
  };
  for (const line of md.split("\n")) {
    const m = HEADER.exec(line);
    if (m) {
      flush();
      cur = { at: m[1], by: m[2].trim(), lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  flush();
  return out;
}
