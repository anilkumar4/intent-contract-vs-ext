import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateComplianceReport } from "../../src/state/report";
import type { Contract } from "../../src/contract/schema";
import type { ContractSession } from "../../src/state/session";
import type { FileChange, Finding } from "../../src/detectors/types";

describe("Session compliance report generator", () => {
  const sampleContract: Contract = {
    name: "auth-refactor",
    intent: "Migrate auth service to JWT tokens",
    scope: {
      modify: ["src/auth/**"],
      read_only: ["src/config/secrets.ts"],
      modify_symbols: ["signToken", "verifyToken"]
    },
    forbid: ["new_dependencies", "test_weakening", "high_risk_files"],
    allow_exceptions: true
  };

  const sampleSession: ContractSession = {
    baselineTreeHash: "7f2a1b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a",
    baselineRef: "refs/intent-contract/baselines/20261028-abcdef",
    originalBaselineTreeHash: "7f2a1b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a",
    activeContract: ".intent/auth.yaml",
    headSha: "11223344556677889900aabbccddeeff00112233",
    startedAt: new Date(Date.now() - 120000).toISOString()
  };

  it("generates a clean passing compliance certificate when no violations exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-report-test-"));
    try {
      const changes: FileChange[] = [
        { file: "src/auth/jwt.ts", status: "M", additions: [], deletions: [], binary: false, beforeContent: "", afterContent: "export function signToken() {}" },
        { file: "src/auth/types.ts", status: "A", additions: [], deletions: [], binary: false, beforeContent: "", afterContent: "export interface Token {}" }
      ];

      const reportPath = await generateComplianceReport({
        root,
        session: sampleSession,
        contract: sampleContract,
        changes,
        findings: [],
        waivers: new Map()
      });

      expect(reportPath.endsWith(".md")).toBe(true);
      const content = await fs.readFile(reportPath, "utf8");

      expect(content).toContain("Intent Contract AI Safety & Compliance Certificate");
      expect(content).toContain("PASSED (PR Ready)");
      expect(content).toContain("A+ (100% Compliant)");
      expect(content).toContain("auth-refactor");
      expect(content).toContain("Migrate auth service to JWT tokens");
      expect(content).toContain("src/auth/jwt.ts");
      expect(content).toContain("src/auth/types.ts");
      expect(content).toContain("Zero assertion deletions, matcher downgrades, or skipped tests");
      expect(content).toContain("Cryptographic Audit Seal");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("flags active violations accurately in the scorecard when findings are present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-report-violations-test-"));
    try {
      const changes: FileChange[] = [
        { file: "src/unauthorized.ts", status: "M", additions: [], deletions: [], binary: false, beforeContent: "", afterContent: "" }
      ];
      const findings: Finding[] = [
        {
          id: "scope-err-1",
          detector: "scope",
          severity: "error",
          file: "src/unauthorized.ts",
          message: "File is declared read-only or outside permitted scope",
          evidence: "diff hunk",
          remediation: "Revert file to baseline"
        }
      ];

      const reportPath = await generateComplianceReport({
        root,
        session: sampleSession,
        contract: sampleContract,
        changes,
        findings,
        waivers: new Map()
      });

      const content = await fs.readFile(reportPath, "utf8");
      expect(content).toContain("FAILED (Violations Detected)");
      expect(content).toContain("1 unauthorized file modification(s)");
      expect(content).toContain("src/unauthorized.ts");
      expect(content).toContain("Revert file to baseline");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("exports an SVG badge and PR comment when requested", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-report-badge-test-"));
    try {
      const badgePath = path.join(root, "badge.svg");
      const prCommentPath = path.join(root, "pr-comment.md");

      await generateComplianceReport({
        root,
        session: sampleSession,
        contract: sampleContract,
        changes: [],
        findings: [],
        waivers: new Map()
      }, { badgePath, prCommentPath });

      const badgeContent = await fs.readFile(badgePath, "utf8");
      expect(badgeContent).toContain("<svg");
      expect(badgeContent).toContain("passing");
      expect(badgeContent).toContain("#2ea44f");

      const prCommentContent = await fs.readFile(prCommentPath, "utf8");
      expect(prCommentContent).toContain("Intent Contract CI Report: ✅ PASSED");
      expect(prCommentContent).toContain("All changesets strictly satisfy task scope");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
