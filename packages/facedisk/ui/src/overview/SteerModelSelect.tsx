import { NativeSelect } from "../ui/native-select.js";

/**
 * "Switch model" for a prompt applied now: an optional model for the running step. Only shown for
 * mode "now" and a tool that can switch (claude-agent, claude-code); "At next step" never has it.
 */
export function SteerModelSelect({
  mode,
  choices,
  value,
  onChange,
}: {
  mode: "next-step" | "now";
  choices: string[];
  /** "" keeps the current model. */
  value: string;
  onChange: (model: string) => void;
}) {
  if (mode !== "now" || choices.length === 0) return null;
  return (
    <label className="flex items-center gap-1.5 text-[length:var(--text-row)] text-ink-muted">
      Switch model
      <NativeSelect
        aria-label="Switch model"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-auto min-w-[8rem]"
      >
        <option value="">Keep the current model</option>
        {choices.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}
