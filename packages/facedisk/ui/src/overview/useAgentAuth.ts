import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { AgentAuthEntry } from "../api-types.js";

/**
 * This project's entry of `runner.status.agentAuth`, read when something is queued (the entry says
 * why claude-agent tasks would be refused). Undefined until known, when the project has no
 * claude-agent role, or when the key may not read it.
 */
export function useAgentAuth(pid: string, active: boolean, refreshKey: string) {
  const [entry, setEntry] = useState<AgentAuthEntry | undefined>(undefined);
  useEffect(() => {
    if (!active) {
      setEntry(undefined);
      return;
    }
    let live = true;
    api
      .runnerStatus()
      .then((r) => live && setEntry(r.agentAuth.find((a) => a.projectId === pid)))
      .catch(() => live && setEntry(undefined));
    return () => {
      live = false;
    };
  }, [pid, active, refreshKey]);
  return entry;
}
