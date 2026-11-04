import { describe, expect, it } from "vitest";
import { gitCommands, parseFilePatch, shellQuote, splitPatch } from "./diff-parse.js";

const PATCH = `diff --git a/a.txt b/a.txt
index 4cb29ea..ea14db2 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,4 @@
 one
-two
+2
 three
+four
diff --git a/new file.txt b/new file.txt
new file mode 100644
--- /dev/null
+++ b/new file.txt
@@ -0,0 +1 @@
+hello
`;

describe("parseFilePatch", () => {
  it("numbers lines and classifies rows", () => {
    const first = splitPatch(PATCH).get("a.txt")!;
    const rows = parseFilePatch(first);
    expect(rows.map((r) => r.kind)).toEqual(["hunk", "ctx", "del", "add", "ctx", "add"]);
    expect(rows[1]).toMatchObject({ oldNo: 1, newNo: 1, text: "one" });
    expect(rows[2]).toMatchObject({ oldNo: 2, text: "two" });
    expect(rows[3]).toMatchObject({ newNo: 2, text: "2" });
    expect(rows[5]).toMatchObject({ newNo: 4, text: "four" });
  });

  it("keeps a deleted line that starts with dashes and the file notes", () => {
    const rows = parseFilePatch(
      "diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -1 +1 @@\n--- a\n+++ b\n",
    );
    expect(rows[0]).toMatchObject({ kind: "note", text: "new file mode 100644" });
    expect(rows.slice(2).map((r) => r.kind)).toEqual(["del", "add"]);
  });
});

describe("splitPatch", () => {
  it("keys segments by file path, including names with spaces", () => {
    const m = splitPatch(PATCH);
    expect([...m.keys()]).toEqual(["a.txt", "new file.txt"]);
    expect(m.get("new file.txt")).toContain("+hello");
  });
});

describe("gitCommands", () => {
  it("quotes the repository path for a POSIX shell", () => {
    expect(shellQuote("/tmp/it's here")).toBe(`'/tmp/it'\\''s here'`);
    const c = gitCommands("/tmp/my repo", "abc123", "boof-runner/t1");
    expect(c.split("\n")).toEqual([
      "git -C '/tmp/my repo' log --oneline abc123..boof-runner/t1",
      "git -C '/tmp/my repo' diff abc123...boof-runner/t1",
      "git -C '/tmp/my repo' merge boof-runner/t1",
    ]);
  });
});
