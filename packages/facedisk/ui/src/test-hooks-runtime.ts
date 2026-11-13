// A tiny stand-in for React's hook runtime, so hooks can be mounted on Node without a DOM.
// Used with `vi.mock("react", () => import("./test-hooks-runtime.js").then((m) => m.fakeReact))`.

type Effect = { deps?: unknown[]; cleanup?: void | (() => void); run: () => void | (() => void) };

let current: Mounted | null = null;

class Mounted {
  hooks: unknown[] = [];
  effects: Effect[] = [];
  idx = 0;
  pending: Effect[] = [];
  scheduled = false;
  dead = false;
  result: unknown;
  constructor(private fn: () => unknown) {}

  render(): void {
    if (this.dead) return;
    this.scheduled = false;
    this.idx = 0;
    this.pending = [];
    const prev = current;
    current = this;
    try {
      this.result = this.fn();
    } finally {
      current = prev;
    }
    for (const e of this.pending) {
      e.cleanup?.();
      e.cleanup = e.run();
    }
  }

  schedule(): void {
    if (this.scheduled || this.dead) return;
    this.scheduled = true;
    queueMicrotask(() => this.render());
  }

  unmount(): void {
    this.dead = true;
    for (const e of this.effects) e.cleanup?.();
  }
}

function same(a?: unknown[], b?: unknown[]): boolean {
  return !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

function slot<T>(init: () => T): T {
  const m = current!;
  const i = m.idx++;
  if (!(i in m.hooks)) m.hooks[i] = init();
  return m.hooks[i] as T;
}

export const fakeReact = {
  useState<T>(init: T | (() => T)) {
    const m = current!;
    const cell = slot(() => ({
      v: typeof init === "function" ? (init as () => T)() : init,
      set: (next: T | ((p: T) => T)) => {
        const nv = typeof next === "function" ? (next as (p: T) => T)(cell.v as T) : next;
        if (!Object.is(nv, cell.v)) {
          cell.v = nv;
          m.schedule();
        }
      },
    }));
    return [cell.v as T, cell.set] as const;
  },
  useRef<T>(init: T) {
    return slot(() => ({ current: init }));
  },
  useMemo<T>(fn: () => T, deps: unknown[]) {
    const cell = slot(() => ({ deps: undefined as unknown[] | undefined, v: undefined as T }));
    if (!same(cell.deps, deps)) {
      cell.v = fn();
      cell.deps = deps;
    }
    return cell.v;
  },
  useCallback<T>(fn: T, deps: unknown[]) {
    return fakeReact.useMemo(() => fn, deps);
  },
  useEffect(run: () => void | (() => void), deps?: unknown[]) {
    const m = current!;
    const e = slot<Effect>(() => {
      const fresh: Effect = { run, deps: undefined };
      m.effects.push(fresh);
      return fresh;
    });
    if (deps === undefined || !same(e.deps, deps)) {
      e.run = run;
      e.deps = deps;
      m.pending.push(e);
    }
  },
};

/** Mount a function that calls hooks; returns its latest result and an unmount. */
export function mount<T>(fn: () => T): { result: () => T; unmount: () => void } {
  const m = new Mounted(fn);
  m.render();
  return { result: () => m.result as T, unmount: () => m.unmount() };
}
