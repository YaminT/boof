import type { RoleAssignment } from "@boof/heart/schema";
import { Button } from "../ui/button.js";
import { NativeSelect } from "../ui/native-select.js";
import { roleModelLabel, roleModelOptions, roleToolAssignment } from "../lib/settings-agents.js";

export function RoleSelects({
  role,
  value,
  tools,
  models,
  allowNone,
  onChange,
  onAddModel,
}: {
  role: string;
  value: RoleAssignment | undefined;
  tools: string[];
  models: Record<string, string[]>;
  allowNone: boolean;
  onChange: (next: RoleAssignment | undefined) => void;
  onAddModel: (tool: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <NativeSelect
        aria-label={`${role} tool`}
        className="w-full"
        value={value?.tool ?? ""}
        onChange={(e) => {
          const tool = e.target.value;
          onChange(tool ? roleToolAssignment(tool, models) : undefined);
        }}
      >
        {allowNone && <option value="">None</option>}
        {tools.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </NativeSelect>
      {value && (
        <span className="flex gap-2">
          <NativeSelect
            aria-label={`${role} model`}
            className="min-w-0 flex-1"
            value={value.model}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
          >
            {roleModelOptions(value.tool, models, value.model).map((m) => (
              <option key={m} value={m}>
                {roleModelLabel(value.tool, m)}
              </option>
            ))}
          </NativeSelect>
          <Button type="button" variant="outline" size="sm" onClick={() => onAddModel(value.tool)}>
            Add…
          </Button>
        </span>
      )}
    </div>
  );
}
