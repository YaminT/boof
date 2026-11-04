/**
 * Orders overlapping requests: `begin()` before each, `accept(seq)` on each reply. A reply is
 * stale (false) when a later request's reply has already been accepted.
 */
export function latestGuard(): { begin(): number; accept(seq: number): boolean } {
  let issued = 0;
  let accepted = 0;
  return {
    begin: () => ++issued,
    accept(seq) {
      if (seq < accepted) return false;
      accepted = seq;
      return true;
    },
  };
}
