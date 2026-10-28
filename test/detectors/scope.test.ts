import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectScope } from "../../src/detectors/scope";
import { parseUnifiedDiff } from "../../src/git/diff";
import type { Contract } from "../../src/detectors/types";

const fixtures = path.resolve(__dirname, "../fixtures");
const baseContract: Contract = {
  name: "billing-fix",
  intent: "Fix proration",
  scope: { modify: ["billing/**"], read_only: ["shared/**"] },
  forbid: [],
  allow_exceptions: true
};

describe("scope detector", () => {
  it("warns for a changed file outside modify", () => {
    const parsed = parseFixture("scope-outside.diff", "M\0README.md\0");
    const findings = detectScope(parsed.changes, baseContract);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ detector: "scope", severity: "warning", file: "README.md" });
  });

  it("does not flag a changed file inside modify", () => {
    const parsed = parseUnifiedDiff(
      "M\0billing/calc.ts\0",
      "diff --git a/billing/calc.ts b/billing/calc.ts\n--- a/billing/calc.ts\n+++ b/billing/calc.ts\n@@ -1 +1 @@\n-old\n+new\n"
    );
    expect(detectScope(parsed.changes, baseContract)).toEqual([]);
  });

  it("creates a stable finding id for unchanged evidence", () => {
    const parsed = parseFixture("scope-outside.diff", "M\0README.md\0");
    const first = detectScope(parsed.changes, baseContract);
    const second = detectScope(parsed.changes, baseContract);
    expect(first[0].id).toBe(second[0].id);
  });

  it("gives read_only precedence over a broad modify glob", () => {
    const contract = { ...baseContract, scope: { modify: ["**"], read_only: ["shared/**"] } };
    const parsed = parseUnifiedDiff("M\0shared/types.ts\0", "diff --git a/shared/types.ts b/shared/types.ts\n");
    expect(detectScope(parsed.changes, contract)).toMatchObject([
      { severity: "error", file: "shared/types.ts" }
    ]);
  });

  it("does not flag a rename when both paths remain inside modify", () => {
    const parsed = parseFixture("rename-inside.diff", "R100\0billing/old.ts\0billing/new.ts\0");
    expect(detectScope(parsed.changes, baseContract)).toEqual([]);
  });

  it("checks both paths of a rename that moves a file outside scope", () => {
    const parsed = parseUnifiedDiff(
      "R090\0billing/calc.ts\0src/calc.ts\0",
      "diff --git a/billing/calc.ts b/src/calc.ts\n"
    );
    expect(detectScope(parsed.changes, baseContract)).toMatchObject([
      { severity: "warning", file: "src/calc.ts" }
    ]);
  });

  it("does not allow a negated glob in scope.modify to widen scope to the whole repository", () => {
    const contract: Contract = {
      ...baseContract,
      scope: { modify: ["src/billing/**", "!src/billing/invoice.ts"], read_only: [] }
    };
    const readmeChange = parseUnifiedDiff("M\0README.md\0", "diff --git a/README.md b/README.md\n");
    const findings = detectScope(readmeChange.changes, contract);
    expect(findings).toContainEqual(
      expect.objectContaining({ file: "README.md", rule: "outside_modify", severity: "warning" })
    );

    const invoiceChange = parseUnifiedDiff("M\0src/billing/invoice.ts\0", "diff --git a/src/billing/invoice.ts b/src/billing/invoice.ts\n");
    const invoiceFindings = detectScope(invoiceChange.changes, contract);
    expect(invoiceFindings).toContainEqual(
      expect.objectContaining({ file: "src/billing/invoice.ts", rule: "outside_modify" })
    );
  });

  it("treats .intent/** as implicitly read-only error even when scope.modify is **", () => {
    const contract: Contract = {
      ...baseContract,
      scope: { modify: ["**"], read_only: [] }
    };
    const intentChange = parseUnifiedDiff("M\0.intent/contract.yaml\0", "diff --git a/.intent/contract.yaml b/.intent/contract.yaml\n");
    const findings = detectScope(intentChange.changes, contract);
    expect(findings).toContainEqual(
      expect.objectContaining({ file: ".intent/contract.yaml", severity: "error", rule: "read_only" })
    );
  });
});

function parseFixture(file: string, status: string) {
  return parseUnifiedDiff(status, fs.readFileSync(path.join(fixtures, file), "utf8"));
}
