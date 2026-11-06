// Pure helpers (browser-safe) for the durable `## Injected` task-body section.

/** One prompt injected into a running task. */
export interface InjectedEntry {
  /** ISO-8601 time of the injection. */
  at: string;
  /** Who injected it: a principal name, or "user". */
  by: string;
  text: string;
  /** `now` interrupted the running step; `next-step` (the default when absent) waited for the next one. */
  mode?: InjectMode;
  /** ISO-8601 time the prompt reached the agent (the next step started, or the steered step reran). */
  appliedAt?: string;
}

export type InjectMode = "next-step" | "now";

const META = /^<!-- boof: (.*) -->$/;
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
  const meta = [
    entry.mode ? `mode=${entry.mode}` : "",
    entry.appliedAt ? `applied=${entry.appliedAt}` : "",
  ].filter(Boolean);
  const head = `### ${entry.at} — ${by}\n\n`;
  return meta.length > 0 ? `${head}<!-- boof: ${meta.join(" ")} -->\n${text}` : `${head}${text}`;
}

/** Parse the section body into entries; text before the first heading is ignored. */
export function parseInjected(md: string): InjectedEntry[] {
  const out: InjectedEntry[] = [];
  let cur: { at: string; by: string; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const entry: InjectedEntry = { at: cur.at, by: cur.by, text: "" };
    const lines = [...cur.lines];
    const first = lines.findIndex((l) => l.trim() !== "");
    const meta = first >= 0 ? META.exec(lines[first]!.trim()) : null;
    if (meta) {
      lines.splice(first, 1);
      for (const part of meta[1]!.split(" ")) {
        const [k, v] = part.split("=");
        if (k === "mode" && (v === "now" || v === "next-step")) entry.mode = v;
        if (k === "applied" && v) entry.appliedAt = v;
      }
    }
    entry.text = lines.join("\n").trim();
    out.push(entry);
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
