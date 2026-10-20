import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectHighRiskFiles } from "../../src/detectors/highRisk";
import type { Contract, FileChange } from "../../src/detectors/types";
import { parseUnifiedDiff } from "../../src/git/diff";

const contract: Contract = {
  name: "risk",
  intent: "Avoid infrastructure changes",
  scope: { modify: ["**"], read_only: [] },
  forbid: ["high_risk_files"],
  allow_exceptions: true
};

describe("high risk file detector", () => {
  it("flags CI workflow changes", () => {
    const fixture = fs.readFileSync(path.resolve(__dirname, "../fixtures/high-risk.diff"), "utf8");
    const parsed = parseUnifiedDiff("M\0.github/workflows/ci.yml\0", fixture);
    expect(detectHighRiskFiles(parsed.changes, contract)).toMatchObject([
      { severity: "error", file: ".github/workflows/ci.yml", detector: "high_risk_files" }
    ]);
  });

  it("flags environment, terraform, Docker, agent config, and lock files", () => {
    const files = [".env.production", "infra/main.tf", "Dockerfile.dev", "docker-compose.yml", ".cursorrules", ".agents/settings.yaml", "pnpm-lock.yaml"];
    const findings = detectHighRiskFiles(files.map(makeChange), contract);
    expect(findings).toHaveLength(files.length);
    expect(findings.every((finding) => finding.severity === "error")).toBe(true);
  });

  it("does not flag an ordinary source file or run when the forbid is absent", () => {
    expect(detectHighRiskFiles([makeChange("src/main.ts")], contract)).toEqual([]);
    expect(detectHighRiskFiles([makeChange("Dockerfile")], { ...contract, forbid: [] })).toEqual([]);
  });
});

function makeChange(file: string): FileChange {
  return { status: "M", file, additions: [], deletions: [], binary: false };
}
