import { describe, expect, it, vi } from "vitest";
import type { Project, Settings } from "@boof/heart/schema";
import { isDirty, startDraft, type PageModel, type PageValues } from "./settings-draft.js";
import { afterSaveEdits, performSave, raiseNotice, type SaveWrites } from "./settings-save.js";

type V = PageValues<{ root: string }, { name: string }>;
// A tiny model: one global field and one project field, patched when they changed.
const model: PageModel<V> = {
  values: (s, p) => ({
    global: { root: (s as unknown as { root: string }).root },
    project: { name: p.name },
  }),
  problems: () => [],
  patches: (form, base) => ({
    ...(form.global.root !== base.global.root
      ? { settings: { projectsRoot: form.global.root } }
      : {}),
    ...(form.project.name !== base.project.name ? { project: { name: form.project.name } } : {}),
  }),
};
const settings = { root: "a" } as unknown as Settings;
const project = { name: "n" } as unknown as Project;
const latest = { settings, project };
const edited = (): { d: ReturnType<typeof startDraft<V>>; sent: V } => {
  const d0 = startDraft(model.values(settings, project));
  const sent: V = { global: { root: "typed" }, project: { name: "typed" } };
  return { d: { ...d0, form: sent }, sent };
};
const ok = (): SaveWrites => ({
  settings: vi.fn(async () => ({ root: "typed" }) as unknown as Settings),
  project: vi.fn(async () => ({ name: "typed" }) as unknown as Project),
});

describe("performSave", () => {
  it("both succeed: the page is clean", async () => {
    const { d } = edited();
    const r = await performSave(model, d, latest, ok());
    expect(r.allOk && r.anyOk).toBe(true);
    expect(isDirty(r.draft)).toBe(false);
  });

  it("settings fail (403): the settings edits stay, only they stay dirty, a retry sends only them", async () => {
    const { d } = edited();
    const writes = { ...ok(), settings: vi.fn(async () => undefined) };
    const r = await performSave(model, d, latest, writes);
    expect(r.allOk).toBe(false);
    expect(r.anyOk).toBe(true);
    expect(r.draft.form.global.root).toBe("typed");
    expect(r.draft.base.global.root).toBe("a");
    expect(r.draft.base.project.name).toBe("typed");
    expect(isDirty(r.draft)).toBe(true);
    const retry = model.patches(r.draft.form, r.draft.base, latest);
    expect(retry).toEqual({ settings: { projectsRoot: "typed" } });
  });

  it("project fails: the project edits stay and a retry patches only the project", async () => {
    const { d } = edited();
    const writes = { ...ok(), project: vi.fn(async () => undefined) };
    const r = await performSave(model, d, latest, writes);
    expect(r.draft.form.project.name).toBe("typed");
    expect(r.draft.base.project.name).toBe("n");
    expect(r.draft.base.global.root).toBe("typed");
    expect(model.patches(r.draft.form, r.draft.base, latest)).toEqual({
      project: { name: "typed" },
    });
  });

  it("both fail: the form is unchanged and dirty", async () => {
    const { d } = edited();
    const r = await performSave(model, d, latest, {
      settings: async () => undefined,
      project: async () => undefined,
    });
    expect(r.anyOk).toBe(false);
    expect(r.draft.form).toEqual(d.form);
    expect(r.draft.base).toEqual(d.base);
    expect(isDirty(r.draft)).toBe(true);
  });

  it("a failed half that the server also moved keeps its notice", async () => {
    const { d } = edited();
    const r = await performSave(model, { ...d, elsewhere: true }, latest, {
      ...ok(),
      settings: async () => undefined,
    });
    expect(r.draft.elsewhere).toBe(true);
    const clean = await performSave(model, { ...d, elsewhere: true }, latest, ok());
    expect(clean.draft.elsewhere).toBe(false);
  });

  it("with nothing changed it writes nothing", async () => {
    const writes = ok();
    const d = startDraft(model.values(settings, project));
    const r = await performSave(model, d, latest, writes);
    expect(r.nothing).toBe(true);
    expect(writes.settings).not.toHaveBeenCalled();
    expect(writes.project).not.toHaveBeenCalled();
  });

  it("only the half with changes is written", async () => {
    const d0 = startDraft(model.values(settings, project));
    const d = { ...d0, form: { ...d0.form, project: { name: "x" } } };
    const writes = ok();
    await performSave(model, d, latest, writes);
    expect(writes.settings).not.toHaveBeenCalled();
    expect(writes.project).toHaveBeenCalledWith({ name: "x" });
  });
});

describe("afterSaveEdits", () => {
  it("keeps what was typed during the save and follows the server for the rest", () => {
    const sent: V = { global: { root: "typed" }, project: { name: "typed" } };
    const result = startDraft<V>({ global: { root: "typed" }, project: { name: "server" } });
    const current = { ...result, form: { global: { root: "typed" }, project: { name: "later" } } };
    const out = afterSaveEdits(result, sent, current);
    expect(out.form).toEqual({ global: { root: "typed" }, project: { name: "later" } });
    expect(out.base.project.name).toBe("server");
  });
  it("an untouched field follows the server", () => {
    const sent: V = { global: { root: "typed" }, project: { name: "n" } };
    const result = startDraft<V>({ global: { root: "typed" }, project: { name: "theirs" } });
    const out = afterSaveEdits(result, sent, { ...result, form: sent });
    expect(out.form.project.name).toBe("theirs");
  });
});

describe("a failed half when the server also moved", () => {
  it("keeps its old base, so a retry cannot write the server's newer value back", async () => {
    const { d } = edited();
    const moved = { settings: { root: "theirs" } as unknown as Settings, project };
    const r = await performSave(model, d, moved, { ...ok(), settings: async () => undefined });
    expect(r.draft.base.global.root).toBe("a");
    expect(r.draft.form.global.root).toBe("typed");
    // The retry patch is only what the user typed, never the server's "theirs".
    expect(model.patches(r.draft.form, r.draft.base, moved)).toEqual({
      settings: { projectsRoot: "typed" },
    });
  });

  it("raises the notice when the failed half's server value differs from its base", async () => {
    const { d } = edited();
    const r = await performSave(model, d, latest, { ...ok(), settings: async () => undefined });
    const server: V = { global: { root: "theirs" }, project: { name: "typed" } };
    expect(raiseNotice(r.draft, server, r.failed).elsewhere).toBe(true);
    const same: V = { global: { root: "a" }, project: { name: "typed" } };
    expect(raiseNotice(r.draft, same, r.failed).elsewhere).toBe(false);
    // A half that went through never raises it.
    expect(raiseNotice(r.draft, server, { global: false, project: false }).elsewhere).toBe(false);
  });
});
