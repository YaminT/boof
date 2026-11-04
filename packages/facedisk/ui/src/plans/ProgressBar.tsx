/** A thin progress bar; `percent` is clamped to 0-100. */
export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  const value = Math.min(100, Math.max(0, percent));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className="h-1.5 w-24 overflow-hidden rounded-full bg-line"
    >
      <div className="h-full rounded-full bg-done" style={{ width: `${value}%` }} />
    </div>
  );
}
