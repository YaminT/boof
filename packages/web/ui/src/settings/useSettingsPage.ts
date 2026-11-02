import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { Project, Settings } from "@boof-runner/shared/schema";
import { api } from "../api.js";
import { act } from "../lib/act.js";
import {
  editDraft,
  isDirty,
  savedDraft,
  serverMoved,
  stableKey,
  startDraft,
  type Draft,
  type PageModel,
  type PageValues,
} from "../lib/settings-draft.js";

/**
 * The state of one form page: a draft that starts from the server once and then keeps the user's
 * edits through live refreshes. A refresh only matters when the server value really changed
 * (compared by value, never by object identity). Save sends the model's field-level patches.
 */
export function useSettingsPage<V extends PageValues<unknown, unknown>>(
  model: PageModel<V>,
  settings: Settings,
  project: Project,
  pid: string,
  onSaved: () => Promise<void>,
) {
  const server = useMemo(() => model.values(settings, project), [model, settings, project]);
  const serverKey = stableKey(server);
  const [draft, setDraft] = useState<Draft<V>>(() => startDraft(server));
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const latest = useRef({ server, settings, project, draft });
  latest.current = { server, settings, project, draft };

  // Only a real change of the server value touches the draft.
  useEffect(() => {
    setDraft((d) => serverMoved(d, latest.current.server));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const set = useCallback((update: (v: V) => V) => {
    setDraft((d) => editDraft(d, update(d.form), latest.current.server));
    setSavedAt(null);
  }, []);

  const save = useCallback(async () => {
    const { settings: s, project: p, draft: d } = latest.current;
    const sent = d.form;
    const patches = model.patches(d.form, d.base, { settings: s, project: p });
    setBusy(true);
    let newSettings: Settings | undefined;
    let newProject: Project | undefined;
    let ok = true;
    if (patches.settings) {
      newSettings = await act(() => api.updateSettings(patches.settings!), {
        failure: "Could not save the settings",
      });
      if (!newSettings) ok = false;
    }
    if (patches.project) {
      newProject = await act(() => api.updateProject(pid, patches.project!), {
        failure: "Could not save the project",
      });
      if (!newProject) ok = false;
    }
    const saved = model.values(newSettings ?? s, newProject ?? p);
    // A half whose write failed keeps its old base, so it stays dirty.
    const merged: V = {
      global: patches.settings && !newSettings ? d.base.global : saved.global,
      project: patches.project && !newProject ? d.base.project : saved.project,
    } as V;
    setDraft((cur) => savedDraft(cur, sent, merged));
    setBusy(false);
    if (ok) {
      setSavedAt(Date.now());
      toast.success("Settings saved");
      await onSaved();
    }
  }, [model, pid, onSaved]);

  const reload = useCallback(() => {
    setDraft(startDraft(latest.current.server));
    setSavedAt(null);
  }, []);

  return {
    form: draft.form,
    set,
    dirty: isDirty(draft),
    elsewhere: draft.elsewhere,
    problems: model.problems(draft.form),
    busy,
    savedAt,
    save,
    reload,
  };
}
