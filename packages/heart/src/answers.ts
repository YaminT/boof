// Pure helper (browser-safe) for the task body's `## Answers` section, which keeps every round.

/**
 * Append one round of answers to the earlier rounds in `answers`. A round reads
 *
 *     Round 2:
 *     Questions:
 *     1. Which version?
 *     Answers:
 *     16
 *
 * (no `###` headings: that level is reserved for report headings). The round number counts the
 * `Round N:` lines already present. Lines that would open a top-level task section (`## `) are
 * indented by one space so they cannot split the file.
 */
export function appendAnswerRound(earlier: string, questions: string, answers: string): string {
  const safe = (s: string) =>
    s
      .trim()
      .split("\n")
      .map((l) => (l.startsWith("## ") ? ` ${l}` : l))
      .join("\n");
  const n = (earlier.match(/^Round \d+:$/gm)?.length ?? 0) + 1;
  const round = `Round ${n}:\nQuestions:\n${safe(questions) || "(none recorded)"}\nAnswers:\n${safe(answers)}`;
  return earlier.trim() ? `${earlier.trim()}\n\n${round}` : round;
}
