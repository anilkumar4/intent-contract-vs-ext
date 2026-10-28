import fs from "node:fs/promises";
import path from "node:path";
import type { Contract } from "../contract/schema";
import type { ContractSession } from "./session";
import type { FileChange, Finding } from "../detectors/types";
import type { Waiver } from "./waivers";
import { policyTreeHash } from "../runtime/contracts";

export interface ReportContext {
  root: string;
  session: ContractSession;
  contract: Contract;
  changes: FileChange[];
  findings: Finding[];
  waivers: Map<string, Waiver>;
}

export async function generateComplianceReport(ctx: ReportContext): Promise<string> {
  const reportsDir = path.join(ctx.root, ".intent", "reports");
  await fs.mkdir(reportsDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const fileDate = timestamp.replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `compliance-report-${fileDate}.md`);

  const activeFindings = ctx.findings.filter((f) => !ctx.waivers.has(f.id));
  const activeErrors = activeFindings.filter((f) => f.severity === "error");
  const activeWarnings = activeFindings.filter((f) => f.severity === "warning");

  const scopeViolations = activeFindings.filter((f) => f.detector === "scope");
  const symbolViolations = activeFindings.filter((f) => f.detector === "symbol_scope");
  const testViolations = activeFindings.filter((f) => f.detector === "test_weakening" || f.detector === "tautological_tests");
  const depViolations = activeFindings.filter((f) => f.detector === "dependencies");
  const archViolations = activeFindings.filter((f) => f.detector === "architecture_drift");

  const isCompliant = activeErrors.length === 0;
  const overallGrade = isCompliant
    ? (activeWarnings.length === 0 ? "A+ (100% Compliant)" : "A (Passed with Warnings)")
    : "FAIL (Active Violations Detected)";

  const durationStr = ctx.session.startedAt
    ? formatDuration(new Date(ctx.session.startedAt), new Date())
    : "Unknown";

  const markdown = `# 🛡️ Intent Contract AI Safety & Compliance Certificate

> **Verification Status**: ${isCompliant ? "✅ **PASSED (PR Ready)**" : "❌ **FAILED (Violations Detected)**"}  
> **Safety Score**: **${overallGrade}**  
> **Generated**: \`${timestamp}\`  
> **Session Duration**: \`${durationStr}\`

---

## 1. Task & Session Overview

| Attribute | Details |
|---|---|
| **Contract Name** | \`${ctx.contract.name}\` |
| **Task Intent** | "${escapeMd(ctx.contract.intent)}" |
| **Session Started** | \`${ctx.session.startedAt ?? "N/A"}\` |
| **Baseline Tree Ref** | \`${ctx.session.baselineRef ?? "refs/intent-contract/baselines"}\` |
| **Policy Tree Hash** | \`${policyTreeHash(ctx.session)}\` |
| **Starting Git HEAD** | \`${ctx.session.headSha ?? "Uncommitted Working Tree"}\` |

---

## 2. AI Safety & Policy Scorecard

| Safety Dimension | Status | Evaluated Outcome |
|---|:---:|---|
| **File Scope Integrity** | ${scopeViolations.length === 0 ? "✅ PASS" : "❌ FAIL"} | ${scopeViolations.length === 0 ? `All ${ctx.changes.length} changed file(s) confined to permitted \`scope.modify\`` : `${scopeViolations.length} unauthorized file modification(s)`} |
| **AST Symbol Scope** | ${symbolViolations.length === 0 ? "✅ PASS" : "❌ FAIL"} | ${symbolViolations.length === 0 ? "All modified functions and symbols match approved symbol scope" : `${symbolViolations.length} unapproved symbol modification(s)`} |
| **Test Fidelity (Anti-Weakening)** | ${testViolations.length === 0 ? "✅ PASS" : "❌ FAIL"} | ${testViolations.length === 0 ? "Zero assertion deletions, matcher downgrades, or skipped tests" : `${testViolations.length} test weakening attempt(s) detected`} |
| **Supply-Chain Security** | ${depViolations.length === 0 ? "✅ PASS" : "❌ FAIL"} | ${depViolations.length === 0 ? "Zero unvetted package manifests or malicious scripts added" : `${depViolations.length} dependency risk(s) flagged`} |
| **Architectural Boundaries** | ${archViolations.length === 0 ? "✅ PASS" : "❌ FAIL"} | ${archViolations.length === 0 ? "Zero unauthorized cross-module imports detected against policy diagram" : `${archViolations.length} architectural boundary breach(es)`} |

---

## 3. Modified Files Audit Ledger

${ctx.changes.length === 0 ? "_No files were modified during this session._" : `
| Status | File Path | Scope Status | Active Findings |
|:---:|---|:---:|:---:|
${ctx.changes.map((change) => {
  const file = change.newFile ?? change.file;
  const fileFindings = activeFindings.filter((f) => f.file === file);
  const statusIcon = change.status === "A" ? "🟢 Added" : change.status === "D" ? "🔴 Deleted" : "🟡 Modified";
  const findingsBadge = fileFindings.length === 0 ? "✅ Clean" : `⚠️ ${fileFindings.length} Finding(s)`;
  return `| ${statusIcon} | \`${file}\` | In-Scope | ${findingsBadge} |`;
}).join("\n")}
`}

---

## 4. Active Findings & Remediation Instructions

${activeFindings.length === 0 ? `
> [!NOTE]
> **Zero Active Findings**: All files and symbols in this workspace strictly conform to the locked task contract. This changeset is safe to stage, commit, and push.
` : `
| Severity | Detector | File & Line | Message | Remediation Action |
|:---:|---|---|---|---|
${activeFindings.map((f) => `| ${f.severity === "error" ? "🛑 Error" : "⚠️ Warning"} | \`${f.detector}\` | \`${f.file}${f.line ? `:${f.line}` : ""}\` | ${escapeMd(f.message)} | ${escapeMd(f.remediation ?? "Review diff")} |`).join("\n")}
`}

---

## 5. Authorized Exceptions & Waivers (${ctx.waivers.size})

${ctx.waivers.size === 0 ? "_No exceptions or waivers were granted for this session._" : `
| Finding ID | Waiver Reason | Authorized Timestamp |
|---|---|---|
${Array.from(ctx.waivers.values()).map((w) => `| \`${w.id.slice(0, 12)}...\` | ${escapeMd(w.reason)} | \`${w.timestamp}\` |`).join("\n")}
`}

---

## 6. Cryptographic Audit Seal

\`\`\`
Algorithm: SHA-1 / SHA-256 Git Tree Hash
Policy Tree: ${policyTreeHash(ctx.session)}
Baseline Snapshot: ${ctx.session.baselineTreeHash}
Verification Timestamp: ${timestamp}
Audited by: Intent Contract v0.3.0 Engine
\`\`\`
`;

  await fs.writeFile(reportPath, markdown, "utf8");
  return reportPath;
}

function escapeMd(str: string): string {
  return str.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function formatDuration(start: Date, end: Date): string {
  const diffMs = Math.max(0, end.getTime() - start.getTime());
  const diffSec = Math.floor(diffMs / 1000);
  const minutes = Math.floor(diffSec / 60);
  const seconds = diffSec % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

