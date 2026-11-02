import { describe, expect, it } from "vitest";
import {
  autoPathHint,
  EMPTY_PROJECT_FORM,
  needsConfirm,
  projectFormIssues,
  submitLabel,
  toCreateProjectInput,
} from "./project-form.js";

describe("project form", () => {
  it("auto needs a name and a brief; new needs a directory and a brief; existing needs only a directory", () => {
    expect(projectFormIssues(EMPTY_PROJECT_FORM)).toEqual(["name", "brief"]);
    expect(projectFormIssues({ ...EMPTY_PROJECT_FORM, mode: "new" })).toEqual([
      "directory",
      "brief",
    ]);
    expect(projectFormIssues({ ...EMPTY_PROJECT_FORM, mode: "existing", directory: "/r" })).toEqual(
      [],
    );
    expect(projectFormIssues({ ...EMPTY_PROJECT_FORM, name: " x ", brief: " b " })).toEqual([]);
  });
  it("builds the API body per mode, trimming and omitting blanks", () => {
    expect(toCreateProjectInput({ ...EMPTY_PROJECT_FORM, name: " Shop ", brief: " b " })).toEqual({
      name: "Shop",
      path: { mode: "auto" },
      brief: "b",
    });
    expect(
      toCreateProjectInput({
        ...EMPTY_PROJECT_FORM,
        mode: "new",
        directory: " /p ",
        brief: "b",
        confirm: true,
      }),
    ).toEqual({ path: { mode: "new", directory: "/p", confirm: true }, brief: "b" });
    expect(
      toCreateProjectInput({ ...EMPTY_PROJECT_FORM, mode: "new", directory: "/p", brief: "b" }),
    ).toEqual({ path: { mode: "new", directory: "/p" }, brief: "b" });
    expect(
      toCreateProjectInput({ ...EMPTY_PROJECT_FORM, mode: "existing", directory: "/r" }),
    ).toEqual({ path: { mode: "existing", directory: "/r" } });
  });
  it("recognises the confirm error, labels the button and previews the auto path", () => {
    expect(needsConfirm("directory_not_empty")).toBe(true);
    expect(needsConfirm("invalid_input")).toBe(false);
    expect(needsConfirm(undefined)).toBe(false);
    expect(submitLabel("existing", false)).toBe("Add project");
    expect(submitLabel("auto", true)).toBe("Creating…");
    expect(autoPathHint(undefined, "Shop Front")).toBe("~/boof-projects/shop-front");
    expect(autoPathHint("/srv/p", "")).toBe("/srv/p/<id>");
  });
});
