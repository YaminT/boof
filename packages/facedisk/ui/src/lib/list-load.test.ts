import { describe, expect, it } from "vitest";
import { emptyList, settleList, type ListState } from "./list-load.js";

describe("settleList", () => {
  const prior: ListState<string> = { pid: "a", items: ["old"], loaded: true, error: false };

  it("stores a successful load and clears the error", () => {
    expect(settleList(prior, "a", { ok: true, items: ["new"] })).toEqual({
      pid: "a",
      items: ["new"],
      loaded: true,
      error: false,
    });
  });

  it("keeps the rows on a failed refresh so the page is not blank", () => {
    expect(settleList(prior, "a", { ok: false })).toEqual({
      pid: "a",
      items: ["old"],
      loaded: true,
      error: true,
    });
  });

  it("a failed first load of a project is an empty error, not the previous project's rows", () => {
    expect(settleList(prior, "b", { ok: false })).toEqual({
      pid: "b",
      items: [],
      loaded: true,
      error: true,
    });
    expect(settleList(emptyList(), "b", { ok: false }).items).toEqual([]);
  });
});
