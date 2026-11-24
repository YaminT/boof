import type { TopbarState } from "./topbar.js";

/** States whose text carries a reason worth announcing (why it stopped, when it resumes). */
const WITH_REASON = new Set<TopbarState["tone"]>(["paused", "waiting", "blocked", "finished"]);

/**
 * What a screen reader hears when the bar changes: the state word, plus the reason for a state that
 * has one. A step change or a queue count moving inside the same state says nothing new, so the
 * text is the same string and the live region stays quiet.
 */
export function announcementOf(state: Pick<TopbarState, "tone" | "text">, word: string): string {
  return WITH_REASON.has(state.tone) ? state.text : word;
}
