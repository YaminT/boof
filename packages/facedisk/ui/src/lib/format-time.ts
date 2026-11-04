export function formatTime(value: string | number): string {
  const numeric = typeof value === "number" || /^\d+$/.test(value);
  const raw = numeric ? Number(value) : Date.parse(value);
  const ms = numeric && raw < 1e12 ? raw * 1000 : raw;
  if (!Number.isFinite(ms)) return "time unavailable";
  const delta = ms - Date.now();
  const relative =
    Math.abs(delta) < 60_000
      ? `${Math.round(Math.abs(delta) / 1000)} s`
      : `${Math.round(Math.abs(delta) / 60_000)} min`;
  const relativeText = delta >= 0 ? `in ${relative}` : `${relative} ago`;
  return `${new Date(ms).toLocaleString()} (${relativeText})`;
}
