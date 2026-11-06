import { describe, expect, it } from "vitest";
import { afterSave, undoElsewhere, type TaskFormValues } from "./task-form-sync.js";

const values = (over: Partial<TaskFormValues> = {}): TaskFormValues => ({
  title: "Title",
  prompt: "Do the thing",
  priority: 50,
  runs: 1,
  labels: "",
  command: null,
  ...over,
});

describe("afterSave", () => {
  it("stores the trimmed title, so a trailing space is not a false change", () => {
    const typed = values({ title: "Title " });
    const next = afterSave(typed, typed);
    expect(next.base.title).toBe("Title");
    expect(next.form.title).toBe("Title");
  });

  it("keeps keystrokes made while the save was in flight", () => {
    const sent = values({ title: "Title " });
    const typedMore = values({ title: "Title extra" });
    const next = afterSave(sent, typedMore);
    expect(next.base.title).toBe("Title");
    expect(next.form.title).toBe("Title extra");
  });
});

describe("undoElsewhere", () => {
  it("adopts the server copy when the edits are undone", () => {
    const base = values({ title: "Old" });
    const server = values({ title: "Theirs" });
    expect(undoElsewhere(true, base, base, server)).toEqual({
      form: server,
      base: server,
      elsewhere: false,
    });
  });

  it("stays up while the form still differs from its base", () => {
    const base = values({ title: "Old" });
    const form = values({ title: "Mine" });
    expect(undoElsewhere(true, form, base, values({ title: "Theirs" }))).toBeNull();
  });

  it("does nothing when the notice is not showing", () => {
    const v = values();
    expect(undoElsewhere(false, v, v, values({ title: "Theirs" }))).toBeNull();
  });
});
