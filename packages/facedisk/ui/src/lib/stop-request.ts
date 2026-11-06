/**
 * Stop stays disabled from the moment a stop is requested until the task leaves "running".
 * The server records the request in the task's control directory, which the task view does not
 * carry, so the UI keeps a latch and clears it when the status changes or the request fails.
 * Pass `requested: false` for a failed request: Stop is enabled again while the task still runs.
 */
export function stopDisabled(status: string, requested: boolean): boolean {
  return requested && status === "running";
}
