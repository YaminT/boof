import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { moveItem, newItem, type WizardItem } from "../lib/wizard.js";

/** The editable task list of the plan wizard: title, details, order and "after the previous one". */
export function WizardTaskList({
  items,
  onChange,
  disabled,
}: {
  items: WizardItem[];
  onChange: (next: WizardItem[]) => void;
  disabled?: boolean;
}) {
  const set = (i: number, patch: Partial<WizardItem>) =>
    onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  return (
    <div className="flex flex-col gap-3">
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {items.map((it, i) => (
          <li
            key={it.key}
            className="flex flex-col gap-2 rounded-lg border border-line p-3"
            data-testid="wizard-task"
          >
            <div className="flex items-center gap-2">
              <span className="w-6 text-ink-muted tabular-nums">{i + 1}.</span>
              <Input
                aria-label={`Task ${i + 1} title`}
                placeholder="Task title"
                value={it.title}
                disabled={disabled}
                onChange={(e) => set(i, { title: e.target.value })}
              />
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Move task ${i + 1} up`}
                disabled={disabled || i === 0}
                onClick={() => onChange(moveItem(items, i, i - 1))}
              >
                Up
              </Button>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Move task ${i + 1} down`}
                disabled={disabled || i === items.length - 1}
                onClick={() => onChange(moveItem(items, i, i + 1))}
              >
                Down
              </Button>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Remove task ${i + 1}`}
                disabled={disabled}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </div>
            <Textarea
              aria-label={`Task ${i + 1} details`}
              placeholder="Details (optional)"
              rows={2}
              value={it.details}
              disabled={disabled}
              onChange={(e) => set(i, { details: e.target.value })}
            />
            {i > 0 && (
              <label className="flex items-center gap-2 text-[length:var(--text-row)] text-ink-muted">
                <input
                  type="checkbox"
                  checked={it.afterPrevious}
                  disabled={disabled}
                  onChange={(e) => set(i, { afterPrevious: e.target.checked })}
                />
                Start only after the previous task is done
              </label>
            )}
          </li>
        ))}
      </ol>
      <div>
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() => onChange([...items, newItem()])}
        >
          Add a task
        </Button>
      </div>
    </div>
  );
}
