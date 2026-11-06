import { describe, expect, it } from "vitest";
import {
  changedKeys,
  editDraft,
  isDirty,
  sameValue,
  savedDraft,
  rebase,
  changedLeaves,
  serverMoved,
  startDraft,
} from "./settings-draft.js";

const v = { name: "a", review: { gate: true } };

describe("sameValue", () => {
  it("ignores undefined members and key order", () => {
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe("serverMoved", () => {
  it("keeps typed edits across an equal new object (a live refresh)", () => {
    const d = { ...startDraft(v), form: { ...v, name: "typed" } };
    const next = serverMoved(d, structuredClone(v));
    expect(next.form.name).toBe("typed");
    expect(next.elsewhere).toBe(false);
  });
  it("replaces a clean form with a different server value", () => {
    const server = { ...v, name: "b" };
    const next = serverMoved(startDraft(v), server);
    expect(next.form).toEqual(server);
    expect(next.base).toEqual(server);
    expect(next.elsewhere).toBe(false);
  });
  it("keeps a dirty form and flags it when the server value differs", () => {
    const d = { ...startDraft(v), form: { ...v, name: "typed" } };
    const next = serverMoved(d, { ...v, name: "b" });
    expect(next.form.name).toBe("typed");
    expect(next.base).toEqual(v);
    expect(next.elsewhere).toBe(true);
  });
  it("clears the flag when the server value returns to the base", () => {
    const d = { ...startDraft(v), form: { ...v, name: "typed" }, elsewhere: true };
    const next = serverMoved(d, v);
    expect(next.elsewhere).toBe(false);
    expect(next.form.name).toBe("typed");
  });
});

describe("editDraft", () => {
  it("undoing every edit while flagged starts over from the server", () => {
    const d = { ...startDraft(v), form: { ...v, name: "typed" }, elsewhere: true };
    const server = { ...v, name: "b" };
    const next = editDraft(d, v, server);
    expect(next.form).toEqual(server);
    expect(next.elsewhere).toBe(false);
  });
  it("just sets the form otherwise", () => {
    const next = editDraft(startDraft(v), { ...v, name: "x" }, v);
    expect(next.form.name).toBe("x");
    expect(isDirty(next)).toBe(true);
  });
});

describe("savedDraft", () => {
  it("adopts the saved value when the form is what was sent", () => {
    const sent = { ...v, name: "x" };
    const saved = { ...v, name: "x", review: { gate: false } };
    const d = { ...startDraft(v), form: sent, elsewhere: true };
    const next = savedDraft(d, sent, saved);
    expect(next).toEqual({ base: saved, form: saved, elsewhere: false });
  });
  it("keeps edits made during the save", () => {
    const sent = { ...v, name: "x" };
    const d = { ...startDraft(v), form: { ...v, name: "later" } };
    const next = savedDraft(d, sent, sent);
    expect(next.form.name).toBe("later");
    expect(next.base).toEqual(sent);
  });
});

describe("changedKeys", () => {
  it("lists the keys whose values differ", () => {
    expect(changedKeys({ a: 1, b: [1] }, { a: 1, b: [2] })).toEqual(["b"]);
  });
});

describe("rebase", () => {
  it("keeps what the user typed during the save on top of what the server returned", () => {
    const sent = { a: 2, b: 1 };
    const form = { a: 2, b: 1, c: "x" };
    const saved = { a: 2, b: 9 };
    const out = rebase<Record<string, unknown>>(saved, sent, form);
    expect(out).toEqual({ a: 2, b: 9, c: "x" });
    expect(changedKeys(out, saved)).toEqual(["c"]);
  });
  it("follows the server for untouched fields another writer changed", () => {
    expect(rebase({ on: true, n: 1 }, { on: false, n: 1 }, { on: false, n: 5 })).toEqual({
      on: true,
      n: 5,
    });
  });
});

describe("changedLeaves", () => {
  it("reports leaves, not whole nested objects", () => {
    const base = { limits: { perDayUsd: 1, perTaskUsd: 2 }, list: [1] };
    const form = { limits: { perDayUsd: 1, perTaskUsd: 3 }, list: [1, 2] };
    expect(changedLeaves(form, base)).toEqual(["limits.perTaskUsd", "list"]);
    expect(changedLeaves(base, base)).toEqual([]);
  });
  it("sees added and removed keys", () => {
    expect(changedLeaves({ a: { b: 1 } }, {})).toEqual(["a.b"]);
    expect(changedLeaves({}, { a: 1 })).toEqual(["a"]);
  });
});
