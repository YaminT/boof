import type { GoalSpec } from "./plan-schema.js";

/** What a task prompt is built from; a change to any part bumps the goal revision. */
export interface GoalContent {
  spec: GoalSpec;
  dependsOn: string[];
  model?: string;
}

export interface SpecChange {
  /** e.g. "goal", "rules.do", "tests.run", "dependsOn", "model". */
  field: string;
  before: string | string[] | undefined;
  after: string | string[] | undefined;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** True when two goals would produce the same task prompt. */
export function sameGoalContent(a: GoalContent, b: GoalContent): boolean {
  return diffGoalContent(a, b).length === 0;
}

/** Field-by-field changes between two goal contents (empty when equal). */
export function diffGoalContent(before: GoalContent, after: GoalContent): SpecChange[] {
  const out: SpecChange[] = [];
  const str = (field: string, a: string | undefined, b: string | undefined) => {
    if (a !== b) out.push({ field, before: a, after: b });
  };
  const list = (field: string, a: string[], b: string[]) => {
    if (!sameList(a, b)) out.push({ field, before: a, after: b });
  };
  str("goal", before.spec.goal, after.spec.goal);
  str("stack", before.spec.stack, after.spec.stack);
  list("rules.do", before.spec.rules.do, after.spec.rules.do);
  list("rules.dont", before.spec.rules.dont, after.spec.rules.dont);
  str("tests.strategy", before.spec.tests.strategy, after.spec.tests.strategy);
  str("tests.technology", before.spec.tests.technology, after.spec.tests.technology);
  str("tests.run", before.spec.tests.run, after.spec.tests.run);
  str("tests.coverage", before.spec.tests.coverage, after.spec.tests.coverage);
  list("dependsOn", before.dependsOn, after.dependsOn);
  str("model", before.model, after.model);
  return out;
}

const quote = (s: string | undefined): string => (s === undefined ? "(none)" : JSON.stringify(s));

/** The changes as a markdown list that stays readable inside a prompt. */
export function renderChanges(changes: SpecChange[]): string {
  return changes
    .map((c) => {
      if (Array.isArray(c.before) && Array.isArray(c.after)) {
        const removed = c.before.filter((x) => !c.after!.includes(x));
        const added = (c.after as string[]).filter((x) => !c.before!.includes(x));
        const parts = [
          ...removed.map((x) => `removed ${quote(x)}`),
          ...added.map((x) => `added ${quote(x)}`),
        ];
        if (parts.length === 0) parts.push("reordered");
        return `- ${c.field}: ${parts.join("; ")}`;
      }
      return `- ${c.field}: ${quote(c.before as string | undefined)} → ${quote(c.after as string | undefined)}`;
    })
    .join("\n");
}

/** A goal content as stable plain text; the input of {@link unifiedDiff}. */
export function renderGoalContent(c: GoalContent): string {
  const lines = [
    "goal: " + c.spec.goal,
    "stack: " + c.spec.stack,
    ...c.spec.rules.do.map((d) => "do: " + d),
    ...c.spec.rules.dont.map((d) => "dont: " + d),
    "tests.strategy: " + c.spec.tests.strategy,
    "tests.technology: " + c.spec.tests.technology,
    "tests.run: " + c.spec.tests.run,
  ];
  if (c.spec.tests.coverage) lines.push("tests.coverage: " + c.spec.tests.coverage);
  if (c.dependsOn.length > 0) lines.push("depends-on: " + c.dependsOn.join(", "));
  if (c.model) lines.push("model: " + c.model);
  return lines.join("\n");
}

/**
 * Unified diff (whole-file hunk with 2 lines of context per change region) of two texts, by
 * longest common subsequence. Empty string when equal.
 */
export function unifiedDiff(before: string, after: string, context = 2): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: { t: " " | "-" | "+"; s: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", s: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ t: "-", s: a[i]! });
      i += 1;
    } else {
      ops.push({ t: "+", s: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ t: "-", s: a[i++]! });
  while (j < b.length) ops.push({ t: "+", s: b[j++]! });

  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, k) => {
    if (op.t === " ") return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x += 1) {
      keep[x] = true;
    }
  });
  const out: string[] = ["--- previous", "+++ current"];
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) {
      k += 1;
      continue;
    }
    let end = k;
    while (end < ops.length && keep[end]) end += 1;
    out.push("@@ @@");
    for (let x = k; x < end; x += 1) out.push(ops[x]!.t + ops[x]!.s);
    k = end;
  }
  return out.join("\n");
}
