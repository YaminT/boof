import { describe, expect, it } from "vitest";
import {
  applySandboxMode,
  sandboxLists,
  sandboxNoticeVisible,
  sandboxSettingsHref,
  sandboxStateText,
  sandboxUnavailableReason,
  dismissSandboxNotice,
  readSandboxNoticeDismissed,
} from "./sandbox-ui.js";

describe("sandbox notice", () => {
  it("shows only while mode is off, the self-test would pass, and it was not dismissed", () => {
    expect(sandboxNoticeVisible({ mode: "off", offer: true, dismissed: false })).toBe(true);
    expect(sandboxNoticeVisible({ mode: "off", offer: false, dismissed: false })).toBe(false);
    expect(sandboxNoticeVisible({ mode: "off", offer: true, dismissed: true })).toBe(false);
    expect(sandboxNoticeVisible({ mode: "enforce", offer: true, dismissed: false })).toBe(false);
  });

  it("remembers a dismissal", () => {
    const storage = new Map<string, string>();
    const box = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    };
    expect(readSandboxNoticeDismissed(box)).toBe(false);
    dismissSandboxNotice(box);
    expect(readSandboxNoticeDismissed(box)).toBe(true);
  });
});

describe("sandbox state text", () => {
  it("names the three states", () => {
    expect(
      sandboxStateText({ mode: "off", state: "off", reason: "agents are not sandboxed" }),
    ).toBe("Off. Agents are not sandboxed.");
    expect(sandboxStateText({ mode: "enforce", state: "ok", reason: "" })).toBe(
      "On. The sandbox self-test passed.",
    );
    expect(
      sandboxStateText({
        mode: "enforce",
        state: "ok",
        reason: "signals not scoped (kernel older than 6.12)",
      }),
    ).toBe("On. The sandbox self-test passed. signals not scoped (kernel older than 6.12)");
    expect(
      sandboxStateText({
        mode: "enforce",
        state: "unavailable",
        reason: "boof-sandbox helper is missing",
      }),
    ).toBe("Unavailable. boof-sandbox helper is missing");
  });
});

describe("sandbox lists", () => {
  it("reads one path or port per line and rejects a bad line", () => {
    expect(sandboxLists({ read: "/usr/local\n", write: "", ports: "8080\n" })).toEqual({
      ok: true,
      readPaths: ["/usr/local"],
      writePaths: [],
      denyTcpPorts: [8080],
    });
    const bad = sandboxLists({ read: "relative", write: "/ok", ports: "0" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.problems.join("\n")).toContain("Read-only folders");
      expect(bad.problems.join("\n")).toContain("Blocked TCP ports");
    }
  });
});

describe("sandbox_unavailable on a task", () => {
  it("reads the reason from the not-started line and from an error line", () => {
    expect(
      sandboxUnavailableReason("### Not started\nsandbox_unavailable: helper is missing\n"),
    ).toBe("helper is missing");
    expect(sandboxUnavailableReason("ERROR: sandbox_unavailable: landlock abi 3 is below 4")).toBe(
      "landlock abi 3 is below 4",
    );
    expect(sandboxUnavailableReason("ERROR: tool failed")).toBeNull();
  });

  it("links to the sandbox setting", () => {
    expect(sandboxSettingsHref("alpha")).toBe("p/alpha/settings/agents#sandbox");
  });
});

describe("applySandboxMode", () => {
  it("returns the refusal reason and does not treat it as success", async () => {
    const update = async () => {
      throw new Error("landlock abi 3 is below 4");
    };
    await expect(applySandboxMode("enforce", update)).resolves.toEqual({
      ok: false,
      reason: "landlock abi 3 is below 4",
    });
  });

  it("returns ok when the update is accepted", async () => {
    const seen: string[] = [];
    await expect(
      applySandboxMode("enforce", async (mode) => {
        seen.push(mode);
      }),
    ).resolves.toEqual({ ok: true });
    expect(seen).toEqual(["enforce"]);
  });
});
