import type { Project, Settings } from "@boof-runner/shared/schema";
import {
  rebase,
  sameValue,
  savedDraft,
  type Draft,
  type PageModel,
  type PagePatches,
  type PageValues,
} from "./settings-draft.js";

/** The two writes a page can make. Each resolves to the saved copy, or undefined when it failed. */
export interface SaveWrites {
  settings(patch: NonNullable<PagePatches["settings"]>): Promise<Settings | undefined>;
  project(patch: NonNullable<PagePatches["project"]>): Promise<Project | undefined>;
}

export interface SaveResult<V> {
  draft: Draft<V>;
  /** Which halves had a write that failed. */
  failed: { global: boolean; project: boolean };
  /** Nothing was sent: the form had no changes. */
  nothing: boolean;
  /** Every write that was needed went through. */
  allOk: boolean;
  /** At least one write went through, so the app's copies of settings and project are stale. */
  anyOk: boolean;
}

/**
 * Save a page: build the field-level patches, run the writes, and work out the draft afterwards.
 * A half whose write failed keeps the user's edits and its old base, so it stays dirty and a retry
 * sends only that half. A half that went through is rebased: what the server returned, plus only
 * what the user typed after the write was sent.
 */
export async function performSave<V extends PageValues<unknown, unknown>>(
  model: PageModel<V>,
  draft: Draft<V>,
  latest: { settings: Settings; project: Project },
  writes: SaveWrites,
): Promise<SaveResult<V>> {
  const patches = model.patches(draft.form, draft.base, latest);
  if (!patches.settings && !patches.project) {
    return {
      draft,
      failed: { global: false, project: false },
      nothing: true,
      allOk: true,
      anyOk: false,
    };
  }
  const sent = draft.form;
  const newSettings = patches.settings ? await writes.settings(patches.settings) : undefined;
  const newProject = patches.project ? await writes.project(patches.project) : undefined;
  const settingsFailed = !!patches.settings && !newSettings;
  const projectFailed = !!patches.project && !newProject;
  const saved = model.values(newSettings ?? latest.settings, newProject ?? latest.project);
  const base = {
    global: settingsFailed ? draft.base.global : saved.global,
    project: projectFailed ? draft.base.project : saved.project,
  } as V;
  const rebased = savedDraft(draft, sent, saved);
  const next: Draft<V> = {
    base,
    form: {
      global: settingsFailed ? draft.form.global : rebased.form.global,
      project: projectFailed ? draft.form.project : rebased.form.project,
    } as V,
    // A failed half that the server also moved keeps its notice.
    elsewhere: (settingsFailed || projectFailed) && draft.elsewhere,
  };
  return {
    draft: next,
    failed: { global: settingsFailed, project: projectFailed },
    nothing: false,
    allOk: !settingsFailed && !projectFailed,
    anyOk: !!newSettings || !!newProject,
  };
}

/** Re-applies the edits made while a save ran, on the draft the save produced. */
export function afterSaveEdits<V extends PageValues<unknown, unknown>>(
  result: Draft<V>,
  sent: V,
  current: Draft<V>,
): Draft<V> {
  const global = rebase(result.form.global, sent.global, current.form.global);
  const project = rebase(result.form.project, sent.project, current.form.project);
  return { ...result, form: { global, project } as V };
}

/**
 * A live refresh may land while a save runs. When a half then fails, its base stays old, so if the
 * server's value for it is different, say so: the edits and the server have diverged.
 */
export function raiseNotice<V extends PageValues<unknown, unknown>>(
  d: Draft<V>,
  server: V,
  failed: { global: boolean; project: boolean },
): Draft<V> {
  const diverged =
    (failed.global && !sameValue(server.global, d.base.global)) ||
    (failed.project && !sameValue(server.project, d.base.project));
  return diverged ? { ...d, elsewhere: true } : d;
}
