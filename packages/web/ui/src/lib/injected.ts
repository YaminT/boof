/** One prompt injected into a running task, as recorded in the task's `## Injected` section. */
export interface InjectedEntry {
  /** ISO-8601 time of the injection. */
  at: string;
  by: string;
  text: string;
  /** `next-step` when the marker is absent. */
  mode: "next-step" | "now";
  /** ISO-8601 time the prompt reached the agent; absent while it waits. */
  appliedAt?: string;
}

const META = /^<!-- boof: (.*) -->$/;
const HEADER = /^### (\d{4}-\d{2}-\d{2}T\S+) — (.*)$/;

/**
 * The entries of `task.body.injected`, oldest first. Same format as `packages/shared/src/injected.ts`
 * (a copy: the UI does not value-import the runner package).
 */
export function parseInjected(md: string): InjectedEntry[] {
  const out: InjectedEntry[] = [];
  let cur: { at: string; by: string; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const entry: InjectedEntry = { at: cur.at, by: cur.by, text: "", mode: "next-step" };
    const lines = [...cur.lines];
    const first = lines.findIndex((l) => l.trim() !== "");
    const meta = first >= 0 ? META.exec(lines[first].trim()) : null;
    if (meta) {
      lines.splice(first, 1);
      for (const part of meta[1].split(" ")) {
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
