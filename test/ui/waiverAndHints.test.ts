import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  default: {},
  window: {},
  commands: {},
  Uri: {}
}));

import { formatTestFidelityHint } from "../../src/ui/dashboard";
import { getContextualWaiverTemplates } from "../../src/ui/actions";
import type { Finding } from "../../src/detectors/types";

describe("Test Fidelity Hint formatter", () => {
  it("formats hint for clean state", () => {
    expect(formatTestFidelityHint([])).toBe("No assertion losses or downgrades");
  });

  it("identifies matcher downgrades dynamically", () => {
    const findings: Finding[] = [
      {
        id: "1",
        detector: "test_weakening",
        file: "test/example.test.ts",
        rule: "matcher_downgrade",
        message: "Downgraded toBe to toBeTruthy",
        severity: "error",
        evidence: "expect(val).toBeTruthy()"
      }
    ];
    expect(formatTestFidelityHint(findings)).toBe("Detected weakened matchers");
  });

  it("identifies assertion deletions dynamically", () => {
    const findings: Finding[] = [
      {
        id: "2",
        detector: "test_weakening",
        file: "test/example.test.ts",
        rule: "net_assertion_loss",
        message: "Assertions deleted",
        severity: "error",
        evidence: "- expect(a).toBe(b)"
      }
    ];
    expect(formatTestFidelityHint(findings)).toBe("Detected deleted assertions");
  });

  it("combines multiple categories into informative hint", () => {
    const findings: Finding[] = [
      {
        id: "1",
        detector: "test_weakening",
        file: "test/example.test.ts",
        rule: "matcher_downgrade",
        message: "Downgraded matcher",
        severity: "error",
        evidence: "downgraded"
      },
      {
        id: "2",
        detector: "test_weakening",
        file: "test/example.test.ts",
        rule: "net_assertion_loss",
        message: "Assertion deleted",
        severity: "error",
        evidence: "deleted"
      }
    ];
    expect(formatTestFidelityHint(findings)).toBe("Detected weakened matchers, deleted assertions");
  });

  it("handles skipped tests and widened tolerances", () => {
    const findings: Finding[] = [
      {
        id: "3",
        detector: "test_weakening",
        file: "test/example.test.ts",
        rule: "test_skipped",
        message: "Skipped test",
        severity: "error",
        evidence: "it.skip"
      }
    ];
    expect(formatTestFidelityHint(findings)).toBe("Detected skipped tests");
  });
});

describe("Contextual Waiver Templates", () => {
  it("returns CI/CD-specific suggestions for workflow findings", () => {
    const ciFinding: Finding[] = [
      {
        id: "ci-1",
        detector: "high_risk_files",
        file: ".github/workflows/deploy.yml",
        rule: "agent_instructions",
        message: "Modified workflow",
        severity: "error",
        evidence: "deploy.yml changed"
      }
    ];
    const templates = getContextualWaiverTemplates(ciFinding[0]);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates[0].label).toBe("Approved CI/CD workflow update");
    expect(templates[0].template).toBe("Approved CI/CD workflow update for .github/workflows/deploy.yml");
    expect(templates.some((t) => t.template.includes("Emergency pipeline fix"))).toBe(true);
  });

  it("returns security/credential suggestions for sensitive files", () => {
    const envFinding: Finding = {
      id: "sec-1",
      detector: "high_risk_files",
      file: ".env.production",
      rule: "env_file",
      message: "Modified environment file",
      severity: "error",
      evidence: ".env modified"
    };
    const templates = getContextualWaiverTemplates(envFinding);
    expect(templates[0].label).toContain("Authorized security/credential");
  });

  it("returns dependency-specific suggestions for package additions", () => {
    const depFinding: Finding = {
      id: "dep-1",
      detector: "dependencies",
      file: "package.json",
      rule: "new_dependency",
      message: "Added express",
      severity: "error",
      evidence: "express added"
    };
    const templates = getContextualWaiverTemplates(depFinding);
    expect(templates[0].label).toBe("Approved package addition/upgrade");
    expect(templates[0].template).toBe("Approved dependency addition/update in package.json");
    expect(templates.some((t) => t.label.includes("Security vulnerability fix"))).toBe(true);
  });

  it("returns test-weakening suggestions for test findings", () => {
    const testFinding: Finding = {
      id: "t-1",
      detector: "test_weakening",
      file: "test/checkout.test.ts",
      rule: "matcher_downgrade",
      message: "Downgraded matcher",
      severity: "error",
      evidence: "matcher downgraded"
    };
    const templates = getContextualWaiverTemplates(testFinding);
    expect(templates[0].label).toBe("Intentional test suite refactoring");
    expect(templates[1].label).toBe("Assertion update due to requirement change");
  });

  it("returns architecture-specific suggestions for drift findings", () => {
    const archFinding: Finding = {
      id: "a-1",
      detector: "architecture_drift",
      file: "src/billing/service.ts",
      rule: "undrawn_edge",
      message: "Billing imports Inventory",
      severity: "error",
      evidence: "import from inventory"
    };
    const templates = getContextualWaiverTemplates(archFinding);
    expect(templates[0].label).toContain("Architectural boundary exception");
  });

  it("returns scope extension suggestions for scope violations", () => {
    const scopeFinding: Finding = {
      id: "s-1",
      detector: "scope",
      file: "src/utils/date.ts",
      rule: "outside_modify",
      message: "File modified outside scope",
      severity: "error",
      evidence: "date.ts modified"
    };
    const templates = getContextualWaiverTemplates(scopeFinding);
    expect(templates[0].label).toBe("Approved scope extension");
    expect(templates[0].template).toBe("Approved scope extension for src/utils/date.ts");
  });
});
