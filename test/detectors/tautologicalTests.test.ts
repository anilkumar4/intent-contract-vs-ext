import { describe, expect, it } from "vitest";
import type { FileChange } from "../../src/detectors/types";
import { detectFindings } from "../../src/detectors";
import { detectTautologicalTests } from "../../src/detectors/tautologicalTests";

describe("tautological test detector", () => {
  it("reports a test that asserts the return value of its own mock", () => {
    const change = addedTest(`
      const taxService = { getRate: () => 0 };
      it("uses the tax rate", () => {
        vi.spyOn(taxService, "getRate").mockReturnValue(0.18);
        expect(taxService.getRate()).toBe(0.18);
      });
    `);
    const findings = detectFindings({ changes: [change] }, {
      name: "tautological-test",
      intent: "Keep tests meaningful",
      scope: { modify: ["**"], read_only: [] },
      forbid: ["test_weakening"],
      allow_exceptions: true
    });
    expect(findings).toContainEqual(expect.objectContaining({
      detector: "tautological_tests",
      rule: "self_mocking",
      severity: "error",
      message: expect.stringContaining("Self-Mocking")
    }));
  });

  it("does not flag a mocked database call exercised by the real function under test", () => {
    const change = addedTest(`
      const db = { query: () => [] as number[] };
      function calculateInvoiceTotal(): number {
        return db.query().reduce((total, amount) => total + amount, 0);
      }
      it("calculates invoice total", () => {
        vi.spyOn(db, "query").mockReturnValue([12, 8]);
        expect(calculateInvoiceTotal()).toBe(20);
      });
    `);
    expect(detectTautologicalTests([change])).toEqual([]);
  });

  it("reports a test that calls the implementation without asserting a result", () => {
    const change = addedTest(`
      it("runs invoice", () => { calculateInvoice(); });
    `);
    expect(detectTautologicalTests([change])).toContainEqual(expect.objectContaining({
      rule: "assertion_free_test",
      severity: "error",
      message: expect.stringContaining("Assertion-Free Test")
    }));
  });

  it("reports Python assertion-free tests in test files", () => {
    const content = [
      "def test_legacy():",
      "    calculate_rate()",
      "",
      "def test_rates():",
      "    # assert this comment is not an assertion",
      '    note = "assert in a string"',
      "    calculate_rate()",
      ""
    ].join("\n");
    const pyChange: FileChange = {
      status: "M",
      file: "tests/test_rates.py",
      additions: content.split(/\r?\n/).slice(3).map((text, index) => ({ kind: "add", text, newLine: index + 4 })),
      deletions: [],
      binary: false,
      afterContent: content
    };
    const findings = detectTautologicalTests([pyChange]);
    expect(findings).toContainEqual(expect.objectContaining({
      file: "tests/test_rates.py",
      message: expect.stringContaining("test_rates"),
      detector: "tautological_tests",
      rule: "assertion_free_test"
    }));
    expect(findings).toHaveLength(1);

    const unittestTest: FileChange = {
      status: "M",
      file: "tests/test_unittest.py",
      additions: [
        { kind: "add", text: "def test_rate():", newLine: 1 },
        { kind: "add", text: "    self.assertEqual(calculate_rate(), 1)", newLine: 2 }
      ],
      deletions: [],
      binary: false,
      afterContent: "def test_rate():\n    self.assertEqual(calculate_rate(), 1)\n"
    };
    expect(detectTautologicalTests([unittestTest])).toEqual([]);
  });
});

function addedTest(source: string): FileChange {
  const content = source.trim().split(/\r?\n/).map((line) => line.trim()).join("\n");
  const lines = content.split("\n");
  return {
    status: "A",
    file: "billing/invoice.test.ts",
    newFile: "billing/invoice.test.ts",
    additions: lines.map((text, index) => ({ kind: "add", text, newLine: index + 1 })),
    deletions: [],
    hunks: [{
      oldStart: 0,
      newStart: 1,
      lines: lines.map((text, index) => ({ kind: "add", text, newLine: index + 1 }))
    }],
    binary: false,
    afterContent: content
  };
}
