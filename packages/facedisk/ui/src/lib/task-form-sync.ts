export interface TaskFormValues {
  title: string;
  prompt: string;
  priority: number;
  runs: number;
  labels: string;
  command: string | null;
}

export const parseLabels = (s: string): string[] =>
  s
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

/** Equal ignoring how the labels are spaced. */
export const formKey = (v: TaskFormValues): string =>
  JSON.stringify({ ...v, labels: parseLabels(v.labels) });

/** What a save writes: the title is trimmed, matching the server copy that comes back. */
export function valuesSent(form: TaskFormValues): TaskFormValues {
  return { ...form, title: form.title.trim() };
}

/**
 * After a save, the base is what was sent. Keystrokes made while the save was in flight stay;
 * a form that did not change takes the trimmed title so it does not look dirty.
 */
export function afterSave(
  sentFrom: TaskFormValues,
  current: TaskFormValues,
): { base: TaskFormValues; form: TaskFormValues } {
  const base = valuesSent(sentFrom);
  return { base, form: formKey(current) === formKey(sentFrom) ? base : current };
}

/**
 * Undoing every edit while "changed elsewhere" is showing adopts the server copy and clears the
 * notice. Returns null when the notice should stay.
 */
export function undoElsewhere(
  elsewhere: boolean,
  form: TaskFormValues,
  base: TaskFormValues,
  server: TaskFormValues,
): { form: TaskFormValues; base: TaskFormValues; elsewhere: false } | null {
  if (!elsewhere || formKey(form) !== formKey(base)) return null;
  return { form: server, base: server, elsewhere: false };
}
