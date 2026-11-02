import type { Project, ProjectPatch, Settings, SettingsPatch } from "@boof-runner/shared/schema";

/** JSON with object keys sorted and `undefined` members dropped, so equal values compare equal. */
export function stableKey(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return val;
  });
}

export const sameValue = (a: unknown, b: unknown): boolean => stableKey(a) === stableKey(b);

/** What a form page holds: the server value it started from, the user's edits, and a flag. */
export interface Draft<V> {
  base: V;
  form: V;
  /** The server value moved to something else while the form had unsaved edits. */
  elsewhere: boolean;
}

export const startDraft = <V>(server: V): Draft<V> => ({
  base: server,
  form: server,
  elsewhere: false,
});

export const isDirty = <V>(d: Draft<V>): boolean => !sameValue(d.form, d.base);

/**
 * The server value was refreshed. An equal value (a new object after a live refresh) changes
 * nothing; a different one replaces a clean form and is only announced to a dirty one.
 */
export function serverMoved<V>(d: Draft<V>, server: V): Draft<V> {
  if (sameValue(server, d.base)) return d.elsewhere ? { ...d, elsewhere: false } : d;
  if (!isDirty(d)) return startDraft(server);
  return { ...d, elsewhere: true };
}

/** The user edited the form. Undoing every edit while the notice shows clears the notice. */
export function editDraft<V>(d: Draft<V>, form: V, server: V): Draft<V> {
  const next = { ...d, form };
  return d.elsewhere && !isDirty(next) ? startDraft(server) : next;
}

/** A save went through: `sent` is what was written, `saved` what the server now holds. */
export function savedDraft<V>(d: Draft<V>, sent: V, saved: V): Draft<V> {
  return {
    base: saved,
    form: sameValue(d.form, sent) ? saved : d.form,
    elsewhere: false,
  };
}

/** The keys whose values differ. */
export function changedKeys<T extends object>(form: T, base: T): (keyof T)[] {
  return (Object.keys({ ...base, ...form }) as (keyof T)[]).filter(
    (k) => !sameValue(form[k], base[k]),
  );
}

/** A page's values: the global half (`settings.json`) and the project half (`project.json`). */
export interface PageValues<G, P> {
  global: G;
  project: P;
}

export interface PagePatches {
  settings?: SettingsPatch;
  project?: ProjectPatch;
}

/** One form page: how to read its values, check them and turn the changes into patches. */
export interface PageModel<V extends PageValues<unknown, unknown>> {
  values(s: Settings, p: Project): V;
  problems(v: V): string[];
  patches(form: V, base: V, latest: { settings: Settings; project: Project }): PagePatches;
}
