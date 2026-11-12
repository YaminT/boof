import type { CommandAction } from "./command-actions.js";

/** What the console says for plain words that look like a request. Never a run. */
export interface IntentSuggestion {
  /** Lines to print, one per row. */
  lines: string[];
  /** Command to put in the input so Enter runs it; null when there is nothing to run. */
  prefill: string | null;
}

const MAX_LISTED = 5;

const PLAN = String.raw`(?:the |a |my |all )?(?:draft )?plans?`;
const MAKE_TASKS: RegExp[] = [
  new RegExp(String.raw`^(?:make|create|generate|turn|convert)\s+${PLAN}\s+(?:in)?to\s+tasks?$`),
  new RegExp(
    String.raw`^(?:make|create|generate)\s+(?:the |some |new )?tasks?\s+(?:out of|from)\s+${PLAN}$`,
  ),
  new RegExp(String.raw`^tasks?\s+(?:out of|from)\s+${PLAN}$`),
  new RegExp(String.raw`^(?:activate|start)\s+${PLAN}$`),
];
const START_RUNNER = /^(?:start|run|resume|turn on)\s+(?:the\s+)?runner$/;
const PAUSE = /^(?:pause|stop)\s+(?:everything|all|the runner)$/;
const NEW_PLAN = /^(?:new|create|write|make)\s+(?:a\s+)?plan$/;
const WHAT_RUNNING = /^what(?:'s| is| are)?\s+(?:currently\s+)?running(?: now)?$/;

const clean = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ");

/**
 * A small table of phrasings, matched deterministically (no model). A match only describes a
 * command and offers it; the caller prints the lines and prefills the input. Returns null when
 * the words are not one of the phrasings.
 */
export function matchIntent(input: string, actions: CommandAction[]): IntentSuggestion | null {
  const text = clean(input);
  if (!text || text.startsWith("/")) return null;
  const has = (id: string) => actions.some((a) => a.id === id);

  if (MAKE_TASKS.some((re) => re.test(text))) {
    const drafts = actions.filter((a) => a.id.startsWith("activate-plan-"));
    if (drafts.length === 0) {
      return { lines: ["No draft plan. Type /plan to write one."], prefill: null };
    }
    if (drafts.length === 1) {
      const title = drafts[0]!.targetTitle ?? "";
      return {
        lines: [`Did you mean: /activate ${title}? Press Enter to run it.`],
        prefill: `/activate ${title}`,
      };
    }
    const shown = drafts.slice(0, MAX_LISTED).map((a) => `  ${a.targetTitle ?? ""}`);
    const more = drafts.length > MAX_LISTED ? [`  and ${drafts.length - MAX_LISTED} more`] : [];
    return {
      lines: ["Several draft plans. Finish /activate with one of:", ...shown, ...more],
      prefill: "/activate ",
    };
  }
  if (NEW_PLAN.test(text)) {
    return has("new-plan")
      ? { lines: ["Did you mean: /plan? Press Enter to run it."], prefill: "/plan" }
      : null;
  }
  if (START_RUNNER.test(text) || PAUSE.test(text)) {
    const pause = PAUSE.test(text);
    const toggle = actions.find((a) => a.id === "toggle-runner");
    if (!toggle) return null;
    const verb = pause ? "pause" : "start";
    const already = pause ? toggle.label.startsWith("Start") : toggle.label.startsWith("Pause");
    if (already) {
      return { lines: [`The runner is already ${pause ? "paused" : "running"}.`], prefill: null };
    }
    const cmd = `/runner ${verb}`;
    return { lines: [`Did you mean: ${cmd}? Press Enter to run it.`], prefill: cmd };
  }
  if (WHAT_RUNNING.test(text)) {
    return has("go-overview")
      ? { lines: ["Did you mean: /go overview? Press Enter to run it."], prefill: "/go overview" }
      : null;
  }
  return null;
}
