import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project, Settings } from "@boof-runner/shared/schema";
import { api } from "./api.js";

const STORAGE_KEY = "boof-runner.project";
const HASH_RE = /^#\/p\/([^/?#]+)/;

function readHash(): string | null {
  const m = HASH_RE.exec(window.location.hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

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
    // Storage can be blocked; the URL hash still carries the selection.
  }
  const hash = `#/p/${encodeURIComponent(id)}`;
  if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
}

/**
 * Loads the active projects and tracks which one is selected. The selection lives in
 * the URL hash (`#/p/<pid>`) and localStorage; when neither names an active project
 * it falls back to `settings.defaultProject`, then the first project.
 */
export function useProjects(settings: Settings | null) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [requested, setRequested] = useState<string | null>(() => readHash() ?? readStored());

  const reload = useCallback(async () => {
    setProjects(await api.listProjects());
  }, []);

  useEffect(() => {
    const onHash = () => {
      const id = readHash();
      if (id) setRequested(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const selected = useMemo(() => {
    if (!projects || projects.length === 0) return null;
    const byId = (id: string | null | undefined) => projects.find((p) => p.id === id);
    return byId(requested) ?? byId(settings?.defaultProject) ?? projects[0];
  }, [projects, requested, settings?.defaultProject]);

  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (selectedId) persist(selectedId);
  }, [selectedId]);

  const select = useCallback((id: string) => setRequested(id), []);

  return { projects, selected, selectedId, select, reload };
}
