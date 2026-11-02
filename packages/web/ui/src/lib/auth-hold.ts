/**
 * Rotating the key this browser uses makes the server drop the event stream with a 401 an instant
 * before the new key is stored. While a rotation is under way those 401s must not raise the token
 * gate, which would replace the screen (and the one-time key) with a prompt.
 */
export function createAuthHold(now: () => number = Date.now) {
  let until = 0;
  return {
    /** Ignore 401s for the next `ms` milliseconds, or until `release()`. */
    hold(ms = 5000): void {
      until = now() + ms;
    },
    release(): void {
      until = 0;
    },
    held(): boolean {
      return now() < until;
    },
  };
}
