/** One rendered row of a unified diff. */
export interface DiffRow {
  kind: "hunk" | "add" | "del" | "ctx" | "note";
  /** Line number in the old file (del and ctx rows). */
  oldNo?: number;
  /** Line number in the new file (add and ctx rows). */
  newNo?: number;
  text: string;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse the unified diff of ONE file into rows with line numbers. */
export function parseFilePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const h = HUNK.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk) {
      // File header: keep only what tells the reader something (rename, mode, binary).
      if (
        /^(new file|deleted file|rename |copy |old mode|new mode|similarity|Binary files)/.test(
          line,
        )
      ) {
        rows.push({ kind: "note", text: line });
      }
      continue;
    }
    if (line.startsWith("\\")) rows.push({ kind: "note", text: line });
    else if (line.startsWith("+")) rows.push({ kind: "add", newNo: newNo++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", oldNo: oldNo++, text: line.slice(1) });
    else rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
  }
  return rows;
}

/** Split a multi-file unified diff into per-file segments keyed by the new path. */
export function splitPatch(patch: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = patch.split(/^(?=diff --git )/m);
  for (const part of parts) {
    const header = part.slice(0, part.indexOf("\n") === -1 ? undefined : part.indexOf("\n"));
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(header);
    if (!m) continue;
    // With spaces in names `a/x y b/x y` is ambiguous; the halves are equal then.
    const path = m[1] === m[2] ? m[2]! : (pathFromHeader(header) ?? m[2]!);
    out.set(path, part);
  }
  return out;
}

function pathFromHeader(header: string): string | null {
  const rest = header.slice("diff --git ".length);
  const i = rest.indexOf(" b/");
  return i === -1 ? null : rest.slice(i + 3);
}

/** Quote for a POSIX shell. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The terminal commands to review and merge a task branch (run on the machine that holds the repo). */
export function gitCommands(repo: string | undefined, base: string, branch: string): string {
  const r = repo ? `git -C ${shellQuote(repo)}` : "git";
  return [
    `${r} log --oneline ${base}..${branch}`,
    `${r} diff ${base}...${branch}`,
    `${r} merge ${branch}`,
  ].join("\n");
}
