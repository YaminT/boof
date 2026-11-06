import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { Project, Settings } from "@boof/heart/schema";
import { api } from "../api.js";
import { act } from "../lib/act.js";
import { afterSaveEdits, performSave, raiseNotice } from "../lib/settings-save.js";
import {
  editDraft,
  isDirty,
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

  const saving = useRef(false);
  const save = useCallback(async () => {
    if (saving.current) return;
    const { settings: s, project: p, draft: d } = latest.current;
    if (model.problems(d.form).length > 0) return;
    saving.current = true;
    setBusy(true);
    try {
      const sent = d.form;
      const result = await performSave(
        model,
        d,
        { settings: s, project: p },
        {
          settings: (patch) =>
            act(() => api.updateSettings(patch), { failure: "Could not save the settings" }),
          project: (patch) =>
            act(() => api.updateProject(pid, patch), { failure: "Could not save the project" }),
        },
      );
      if (result.nothing) return;
      // Edits typed while the write ran stay, on top of what the server returned.
      setDraft((cur) =>
        raiseNotice(afterSaveEdits(result.draft, sent, cur), latest.current.server, result.failed),
      );
      if (result.allOk) {
        setSavedAt(Date.now());
        toast.success("Settings saved");
      }
      // Any write that went through makes the app's copies stale.
      if (result.anyOk) await onSaved().catch(() => {});
    } finally {
      saving.current = false;
      setBusy(false);
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
