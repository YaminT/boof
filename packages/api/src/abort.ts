/**
 * Sleep for `ms`, or less when `signal` aborts. Holds exactly one timer and one listener while
 * sleeping and drops both whichever way it ends.
 */
export function sleepUnlessAborted(
  ms: number,
  signal?: AbortSignal,
): Promise<"elapsed" | "aborted"> {
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("elapsed");
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
