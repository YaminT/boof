/** A project-tagged list: a switch never shows another project's rows, and a failed load is visible. */
export interface ListState<T> {
  pid: string | null;
  items: T[];
  loaded: boolean;
  error: boolean;
}

export function emptyList<T>(): ListState<T> {
  return { pid: null, items: [], loaded: false, error: false };
}

/**
 * Apply one load. A failure keeps the rows already shown for that project (a refresh must not
 * blank the page) and sets `error`. A failure for a project we were not showing starts empty.
 */
export function settleList<T>(
  current: ListState<T>,
  pid: string,
  result: { ok: true; items: T[] } | { ok: false },
): ListState<T> {
  if (result.ok) return { pid, items: result.items, loaded: true, error: false };
  return {
    pid,
    items: current.pid === pid ? current.items : [],
    loaded: true,
    error: true,
  };
}
