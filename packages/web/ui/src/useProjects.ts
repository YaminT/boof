import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project, Settings } from "@boof-runner/shared/schema";
import { api } from "./api.js";

const STORAGE_KEY = "boof-runner.project";

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function persist(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage can be blocked; the route still carries the selection.
  }
}

/**
 * Loads the active projects and tracks which one is selected. The route's project wins, then the
 * last one used (localStorage), then `settings.defaultProject`, then the first project. It only
 * persists the selection to localStorage; the URL hash belongs to the router.
 */
export function useProjects(settings: Settings | null, routePid: string | null) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [stored, setStored] = useState<string | null>(readStored);

  const reload = useCallback(async () => {
    setProjects(await api.listProjects());
  }, []);

  const selected = useMemo(() => {
    if (!projects || projects.length === 0) return null;
    const byId = (id: string | null | undefined) => projects.find((p) => p.id === id);
    return byId(routePid) ?? byId(stored) ?? byId(settings?.defaultProject) ?? projects[0] ?? null;
  }, [projects, routePid, stored, settings?.defaultProject]);

  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (selectedId) persist(selectedId);
  }, [selectedId]);

  const select = useCallback((id: string) => setStored(id), []);

  return { projects, selected, selectedId, select, reload };
}
