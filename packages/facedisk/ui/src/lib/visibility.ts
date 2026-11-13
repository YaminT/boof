/** True while the tab is in the background (no document, as in tests, counts as visible). */
export function isHidden(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

/** Call `fn` when the tab becomes visible again. Returns an unsubscribe function. */
export function onBecameVisible(fn: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const handler = () => {
    if (!document.hidden) fn();
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
