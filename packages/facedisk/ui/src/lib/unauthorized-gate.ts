/**
 * Decides what a 401 means. It is tied to the KEY the failed request carried, not to a clock:
 * - a 401 for a key that is no longer the current one is stale and ignored (the old key was
 *   replaced, so of course the old stream or request is refused);
 * - a 401 for the key under rotation, while the rotate request is still pending, is held and
 *   replayed if the rotation then fails;
 * - a 401 for the current key always opens the gate.
 */
export type UnauthorizedVerdict = "stale" | "held" | "notified";

export function createUnauthorizedGate(current: () => string | undefined, notify: () => void) {
  let rotating: string | undefined;
  let pending = false;
  return {
    /** The key `token` is about to be rotated; its 401s wait for the outcome. */
    begin(token: string | undefined): void {
      rotating = token;
      pending = false;
    },
    /** The rotation went through and the new key is stored. */
    succeeded(): void {
      rotating = undefined;
      pending = false;
    },
    /** The rotation failed: the old key is still the current one, so a held 401 is real. */
    failed(): void {
      const replay = pending;
      rotating = undefined;
      pending = false;
      if (replay) notify();
    },
    /** A request or stream sent with `sent` was refused. `undefined` means the current key. */
    unauthorized(sent: string | undefined): UnauthorizedVerdict {
      const now = current();
      if (sent !== undefined && sent !== now) return "stale";
      if (rotating !== undefined && (sent ?? now) === rotating) {
        pending = true;
        return "held";
      }
      notify();
      return "notified";
    },
  };
}
