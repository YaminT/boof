/**
 * Deterministic kebab-case id generation (task-file spec, settings/command ids).
 * Lowercase, whitespace → hyphen, strip anything outside [a-z0-9-], collapse
 * repeated/edge hyphens. Collisions get a numeric suffix (-2, -3, …).
 */

export function toKebabId(input: string): string {
  const base = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base;
}

/**
 * Returns a kebab id derived from `title` that is not present in `existing`.
 * If the derived base is empty (e.g. title was all illegal chars), falls back
 * to "task". Collisions append -2, -3, …
 */
export function uniqueKebabId(title: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = toKebabId(title) || "task";
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
