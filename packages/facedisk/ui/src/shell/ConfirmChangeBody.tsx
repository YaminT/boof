import type { PendingChangeView } from "../api-types.js";
import { CONFIRM_NOTE } from "../lib/assistant-console.js";
import { DELETE_TASK_WARNING } from "../lib/task-delete.js";

/**
 * What the confirm dialog says about one proposed change. The title and every detail line come
 * from the server, already ordered (warnings first, then the "...and N more" line). All of it is
 * plain text: React escapes it, and nothing here is parsed as markdown or HTML.
 */
export function ConfirmChangeBody({ change }: { change: PendingChangeView }) {
  return (
    <div className="flex flex-col gap-3 text-[length:var(--text-row)]">
      <p data-testid="change-title" className="m-0 font-semibold break-words">
        {change.title}
      </p>
      {change.details.length > 0 && (
        <ul data-testid="change-details" className="m-0 flex list-disc flex-col gap-1 pl-5">
          {change.details.map((line, i) => (
            <li key={i} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      )}
      {change.op === "tasks.delete" && (
        <p data-testid="change-delete-warning" className="m-0 text-failed">
          {DELETE_TASK_WARNING}
        </p>
      )}
      <p className="m-0 text-ink-muted">{CONFIRM_NOTE}</p>
    </div>
  );
}
