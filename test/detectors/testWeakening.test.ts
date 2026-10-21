import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Contract } from "../../src/detectors/types";
import { detectFindings } from "../../src/detectors";
import { detectTestWeakening } from "../../src/detectors/testWeakening";
import { parseUnifiedDiff } from "../../src/git/diff";

const fixtureDirectory = path.resolve(__dirname, "../fixtures/test-weakening");
const contract: Contract = {
  name: "phase-two",
  intent: "Keep tests meaningful",
  scope: { modify: ["**"], read_only: [] },
  forbid: ["test_weakening"],
  allow_exceptions: true
};

describe("test weakening detector", () => {
  it("reports net assertion loss in JavaScript and Python test files", () => {
    const js = parseFixture("assertion-loss-js.diff", "M\0billing/tax.test.ts\0");
    const python = parseFixture("assertion-loss-python.diff", "M\0test_tax.py\0");
    expect(detectTestWeakening(js.changes)).toContainEqual(expect.objectContaining({
      rule: "net_assertion_loss", severity: "error", file: "billing/tax.test.ts"
    }));
    expect(detectTestWeakening(python.changes)).toContainEqual(expect.objectContaining({
      rule: "net_assertion_loss", severity: "error", file: "test_tax.py"
    }));
  });

  it("keeps a new test file with three real assertions clean", () => {
    const parsed = parseFixture("added-test-clean.diff", "A\0billing/new.test.ts\0");
    expect(detectTestWeakening(parsed.changes)).toEqual([]);
  });

  it("reports JavaScript skip markers and pytest skip decorators", () => {
    const js = parseFixture("skip-js.diff", "M\0billing/tax.test.ts\0");
    const python = parseFixture("skip-python.diff", "M\0test_tax.py\0");
    expect(detectTestWeakening(js.changes)).toContainEqual(expect.objectContaining({ rule: "disabled_test", severity: "error" }));
    expect(detectTestWeakening(python.changes)).toContainEqual(expect.objectContaining({ rule: "disabled_test", severity: "error" }));
  });

  it("ignores comments that mention skipping a test", () => {
    const parsed = parseFixture("skip-comment-clean.diff", "M\0billing/tax.test.ts\0");
    expect(detectTestWeakening(parsed.changes)).toEqual([]);
  });

  it("reports a strict matcher downgraded to an existence check", () => {
    const parsed = parseFixture("matcher-downgrade.diff", "M\0billing/result.test.ts\0");
    expect(detectTestWeakening(parsed.changes)).toContainEqual(expect.objectContaining({
      rule: "matcher_downgrade", severity: "error", message: expect.stringContaining("toEqual")
    }));
  });

  it("reports widened Jest precision and pytest relative tolerance", () => {
    const js = parseFixture("tolerance-widening.diff", "M\0billing/calc.test.ts\0");
    const python = parseFixture("pytest-tolerance-widening.diff", "M\0test_calc.py\0");
    expect(detectTestWeakening(js.changes)).toContainEqual(expect.objectContaining({ rule: "numeric_tolerance_widened", severity: "error" }));
    expect(detectTestWeakening(python.changes)).toContainEqual(expect.objectContaining({ rule: "numeric_tolerance_widened", severity: "error" }));
  });

  it("reports a changed expected literal when implementation source also changed", () => {
    const parsed = parseFixture(
      "expected-value-with-implementation.diff",
      "M\0src/billing/calc.ts\0M\0billing/tax.test.ts\0"
    );
    expect(detectTestWeakening(parsed.changes)).toContainEqual(expect.objectContaining({
      rule: "expected_value_changed_with_implementation", severity: "error",
      message: expect.stringContaining("19.99 -> 20.00")
    }));
  });

  it("reports tautological JavaScript and Python assertions", () => {
    const parsed = parseFixture("trivial-assertions.diff", "A\0billing/always.test.ts\0A\0test_always.py\0");
    const findings = detectTestWeakening(parsed.changes).filter((finding) => finding.rule === "trivial_assertion");
    expect(findings).toHaveLength(7);
    expect(findings.every((finding) => finding.severity === "error")).toBe(true);
  });

  it("does not flag a variable rename that preserves strict assertions", () => {
    const parsed = parseFixture("variable-rename-clean.diff", "M\0billing/rename.test.ts\0");
    expect(detectTestWeakening(parsed.changes)).toEqual([]);
  });

  it("reports test block loss, deleted test files, empty blocks, and changed snapshots", () => {
    const blockLoss = parseFixture("test-block-loss.diff", "M\0billing/removed.test.ts\0");
    const deleted = parseFixture("deleted-test-file.diff", "D\0billing/deleted.test.ts\0");
    const empty = parseFixture("empty-test-block.diff", "M\0billing/empty.test.ts\0");
    const snapshot = parseFixture("snapshot-change.diff", "M\0billing/__snapshots__/calc.test.ts.snap\0");
    const inlineSnapshot = parseFixture("inline-snapshot-change.diff", "M\0billing/calc.test.ts\0");
    expect(detectTestWeakening(blockLoss.changes)).toContainEqual(expect.objectContaining({ rule: "net_test_block_loss", severity: "error" }));
    expect(detectTestWeakening(deleted.changes)).toContainEqual(expect.objectContaining({ rule: "deleted_test_file", severity: "error" }));
    expect(detectTestWeakening(empty.changes)).toContainEqual(expect.objectContaining({ rule: "empty_test_block", severity: "error" }));
    expect(detectTestWeakening(snapshot.changes)).toContainEqual(expect.objectContaining({ rule: "snapshot_modified", severity: "warning" }));
    expect(detectTestWeakening(inlineSnapshot.changes)).toContainEqual(expect.objectContaining({ rule: "inline_snapshot_changed", severity: "warning" }));
  });

  it("detects negation flips and preserves rule gating in the combined detector", () => {
    const parsed = parseFixture("negation-flip.diff", "M\0billing/result.test.ts\0M\0test_active.py\0M\0test_result.py\0");
    expect(detectTestWeakening(parsed.changes).filter((finding) => finding.rule === "assertion_negation_flip")).toHaveLength(3);
    expect(detectFindings(parsed, { ...contract, forbid: [] }).filter((finding) => finding.detector === "test_weakening")).toEqual([]);
    expect(detectFindings(parsed, contract).some((finding) => finding.detector === "test_weakening")).toBe(true);
  });

  it("produces remediation output grouped by severity", async () => {
    const { formatFindingsForAgent } = await import("../../src/state/formatViolations");
    const parsed = parseFixture("matcher-downgrade.diff", "M\0billing/result.test.ts\0");
    const output = formatFindingsForAgent(detectTestWeakening(parsed.changes));
    expect(output).toContain("## ERROR (Must Fix)");
    expect(output).toContain("billing/result.test.ts:");
    expect(output).toContain("matcher_downgrade");
    expect(output).toContain("Required action:");
    expect(output).toContain("```diff");
  });
});

function parseFixture(fixture: string, nameStatus: string) {
  return parseUnifiedDiff(nameStatus, fs.readFileSync(path.join(fixtureDirectory, fixture), "utf8"));
}
