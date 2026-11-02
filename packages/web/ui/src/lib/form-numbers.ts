export type Parsed<T> = { ok: true; value: T | undefined } | { ok: false };

const empty = (t: string) => t.trim() === "";

/** A whole number of at least `min`; empty means unset. */
export function parseCount(text: string, min: number): Parsed<number> {
  if (empty(text)) return { ok: true, value: undefined };
  const t = text.trim();
  if (!/^\d+$/.test(t)) return { ok: false };
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= min ? { ok: true, value: n } : { ok: false };
}

/** A plain decimal amount of at least one cent, rounded to cents; empty means no limit. */
export function parseUsd(text: string): Parsed<number> {
  if (empty(text)) return { ok: true, value: undefined };
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false };
  const n = Math.round(Number(t) * 100) / 100;
  return Number.isFinite(n) && n >= 0.01 ? { ok: true, value: n } : { ok: false };
}

/** `tool=USD` entries separated by newlines or commas. */
export function parseToolLimits(text: string): Parsed<Record<string, number>> {
  const entries = text
    .split(/[\n,]/)
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length === 0) return { ok: true, value: undefined };
  const out: Record<string, number> = Object.create(null);
  for (const e of entries) {
    const i = e.indexOf("=");
    if (i < 1) return { ok: false };
    const tool = e.slice(0, i).trim();
    const usd = parseUsd(e.slice(i + 1));
    if (!tool || !usd.ok || usd.value === undefined) return { ok: false };
    if (tool in out) return { ok: false };
    out[tool] = usd.value;
  }
  return { ok: true, value: { ...out } };
}

export function toolLimitsText(m: Record<string, number> | undefined): string {
  return Object.entries(m ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}
