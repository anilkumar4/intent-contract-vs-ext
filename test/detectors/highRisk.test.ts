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
    const files = [
      ".env", ".env.production", "infra/main.tf", "infra/prod.tfvars", "infra/main.bicep",
      "Dockerfile.dev", "docker-compose.yml", "k8s/deployment.yaml",
      ".github/CODEOWNERS", ".github/actions/setup/action.yml", ".github/dependabot.yml",
      "Jenkinsfile", "azure-pipelines.yml", ".circleci/config.yml",
      ".npmrc", ".vscode/tasks.json", ".vscode/settings.json", ".husky/pre-commit",
      ".mcp.json", ".cursor/mcp.json", ".cursor/rules/team.mdc",
      "CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md",
      ".cursorrules", ".agents/settings.yaml", "pnpm-lock.yaml"
    ];
    const findings = detectHighRiskFiles(files.map(makeChange), contract);
    expect(findings).toHaveLength(files.length);
    expect(findings.every((finding) => finding.severity === "error" && finding.detector === "high_risk_files")).toBe(true);
  });

  it("supports per-contract custom high_risk include and exclude", () => {
    const customContract: Contract = {
      ...contract,
      high_risk: {
        include: ["helm/**", "db/migrations/**"],
        exclude: [".npmrc"]
      }
    };
    const findings = detectHighRiskFiles([
      makeChange("helm/values.yaml"),
      makeChange("db/migrations/001_init.sql"),
      makeChange(".npmrc")
    ], customContract);

    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.file).sort()).toEqual(["db/migrations/001_init.sql", "helm/values.yaml"]);
  });

  it("does not flag an ordinary source file or run when the forbid is absent", () => {
    expect(detectHighRiskFiles([makeChange("src/main.ts")], contract)).toEqual([]);
    expect(detectHighRiskFiles([makeChange("Dockerfile")], { ...contract, forbid: [] })).toEqual([]);
  });
});

function makeChange(file: string): FileChange {
  return { status: "M", file, additions: [], deletions: [], binary: false };
}
