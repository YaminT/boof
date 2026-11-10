import { Input } from "../ui/input.js";

const inputClass = "min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-ink";
export const AGENT_KEY_HINT =
  "An api-only better-ccflare key for claude-agent. boof keeps the admin client key to itself.";

const labelClass = "flex min-w-0 flex-col gap-1 text-sm text-ink-muted";

/** A write-only better-ccflare key field: shows only whether a key is set, never the key. */
export function GatewayKeyField({
  label,
  noun,
  source,
  value,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  /** "Client key" or "Agent key": used in the status line and the placeholder. */
  noun: string;
  source: "file" | "env" | null | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  hint?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className={labelClass}>
        {label} (write only)
        <Input
          type="password"
          autoComplete="new-password"
          className={inputClass}
          placeholder={source ? "Key is set; enter to replace" : `Optional ${noun.toLowerCase()}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      </label>
      {hint && <p className="m-0 text-xs text-ink-muted">{hint}</p>}
      {source && (
        <p className="m-0 text-sm text-ink-muted">
          {noun}: set ({source})
        </p>
      )}
    </div>
  );
}
