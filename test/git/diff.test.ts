import { describe, expect, it } from "vitest";
import { parseNameStatus, parseUnifiedDiff } from "../../src/git/diff";

describe("Git diff parsing", () => {
  it("parses additions, deletions, renames, and binary file sections", () => {
    const status = "A\0new.txt\0D\0old.txt\0R100\0billing/old.ts\0billing/new.ts\0M\0asset.bin\0";
    const patch = [
      "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new",
      "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old",
      "diff --git a/billing/old.ts b/billing/new.ts\nsimilarity index 100%\nrename from billing/old.ts\nrename to billing/new.ts",
      "diff --git a/asset.bin b/asset.bin\nindex 100..200 100644\nBinary files a/asset.bin and b/asset.bin differ"
    ].join("\n");
    const parsed = parseUnifiedDiff(status, patch);
    expect(parsed.changes.map((change) => change.status)).toEqual(["A", "D", "R", "M"]);
    expect(parsed.changes[0].additions[0]).toMatchObject({ text: "new", newLine: 1 });
    expect(parsed.changes[1].deletions[0]).toMatchObject({ text: "old", oldLine: 1 });
    expect(parsed.changes[2]).toMatchObject({ oldFile: "billing/old.ts", newFile: "billing/new.ts" });
    expect(parsed.changes[3].binary).toBe(true);
  });

  it("uses NUL-delimited names for rename status output", () => {
    expect(parseNameStatus("R087\0old name.txt\0new name.txt\0")).toEqual([
      { status: "R", file: "new name.txt", oldFile: "old name.txt", newFile: "new name.txt" }
    ]);
  });

  it("preserves changed source lines that begin with plus or minus characters", () => {
    const parsed = parseUnifiedDiff(
      "M\0src/signs.ts\0",
      "diff --git a/src/signs.ts b/src/signs.ts\n--- a/src/signs.ts\n+++ b/src/signs.ts\n@@ -1,2 +1,2 @@\n---old\n+++new\n"
    );
    expect(parsed.changes[0].deletions[0].text).toBe("--old");
    expect(parsed.changes[0].additions[0].text).toBe("++new");
  });
});
