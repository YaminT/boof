import type { RunResult } from "./types.js";

export const QUESTIONS_PROTOCOL =
  "To ask a question, end your report with a fenced block tagged `questions`, one question per " +
  "line (numbered or dashed):\n" +
  "```questions\n1. First question\n2. Second question\n```\n" +
  "Add the block only when you genuinely cannot proceed without an answer; when your report " +
  "must end with a `VERDICT:` line, put the block before it.";

export function formatQuestions(questions: string[]): string {
  return `\`\`\`questions\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\`\`\``;
}

const FENCE = /^```[ \t]*([^\s`]*)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
const MARKER = /^(?:\d+[.)]|[-*•])\s*/;

/** Takes the fenced `questions` block that ends a report out of it. */
export function parseQuestions(report: string): { report: string; questions: string[] } {
  let found: { start: number; end: number; body: string } | undefined;
  for (const m of report.matchAll(FENCE)) {
    if (m[1].trim().toLowerCase() === "questions") {
      found = { start: m.index, end: m.index + m[0].length, body: m[2] };
    }
  }
  if (!found) return { report, questions: [] };
  // Only a block that ends the report (before an optional VERDICT line) counts; a block
  // quoted mid-report is documentation, not a question.
  const tail = report.slice(found.end);
  // Emphasis around the line (`**VERDICT: APPROVE**`, backticks) is ignored, as parseVerdict does.
  const isVerdictLine = (line: string) =>
    /^VERDICT:/i.test(line.replace(/^[\s*_`]+|[\s*_`]+$/g, ""));
  if (!tail.split("\n").every((line) => line.trim() === "" || isVerdictLine(line))) {
    return { report, questions: [] };
  }
  const questions = found.body
    .split("\n")
    .map((line) => line.trim().replace(MARKER, "").trim())
    .filter((line) => line !== "");
  if (questions.length === 0) return { report, questions: [] };
  const before = report.slice(0, found.start).trimEnd();
  const after = report.slice(found.end).trimStart();
  return { report: [before, after].filter((s) => s !== "").join("\n\n"), questions };
}

export function withQuestions(result: RunResult): RunResult {
  const parsed = parseQuestions(result.report);
  if (parsed.questions.length === 0) return result;
  return { ...result, report: parsed.report, questions: parsed.questions };
}
