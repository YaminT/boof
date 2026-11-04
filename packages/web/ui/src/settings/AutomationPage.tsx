import { useEffect, useState } from "react";
import type { Project } from "@boof/heart/schema";
import { api } from "../api.js";
import type { Whoami } from "../api-types.js";
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
  const [whoami, setWhoami] = useState<Whoami | null>(null);
  useEffect(() => {
    void api
      .whoami()
      .then(setWhoami)
      .catch(() => {});
  }, []);
  return (
    <div className="flex max-w-[1000px] flex-col gap-10">
      <CommandTemplates whoami={whoami} onChange={onChange} />
      <Webhooks whoami={whoami} projects={projects} />
    </div>
  );
}
