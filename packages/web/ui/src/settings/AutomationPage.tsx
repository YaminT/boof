import type { Project } from "@boof-runner/shared/schema";
import { CommandTemplates } from "./CommandTemplates.js";
import { Webhooks } from "./Webhooks.js";

/** Settings › Automation: command templates and webhooks. Each change saves through its own dialog. */
export function AutomationPage({
  projects,
  onChange,
}: {
  projects: Project[];
  onChange: () => void;
}) {
  return (
    <div className="flex max-w-[1000px] flex-col gap-10">
      <CommandTemplates onChange={onChange} />
      <Webhooks projects={projects} />
    </div>
  );
}
