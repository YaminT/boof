/** Longest workflow name kept, in code points, ellipsis included. */
export const N8N_NAME_MAX = 120;

/**
 * A string from n8n made safe for titles, prompts and logs: control characters become spaces,
 * format characters (bidi overrides, zero-width, BOM) are dropped, whitespace is collapsed, and
 * the result is capped at {@link N8N_NAME_MAX} code points with "…". An empty result falls back
 * to `fallback` (the workflow id).
 */
export function cleanN8nName(raw: string, fallback: string): string {
  const text = raw
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (text === "") return fallback;
  const points = Array.from(text);
  return points.length > N8N_NAME_MAX ? points.slice(0, N8N_NAME_MAX - 1).join("") + "…" : text;
}
