import fs from "node:fs/promises";
import path from "node:path";
import type { Contract, FileChange, Finding } from "../detectors/types";
import type { ContractSession } from "./session";
import { isWaiverActive, type Waiver } from "./waivers";
import { policyTreeHash } from "../runtime/contracts";
import { matchesPatterns } from "../detectors/scope";

export interface ReportContext {
  root: string;
  session: ContractSession;
  contract: Contract;
  changes: FileChange[];
  findings: Finding[];
  waivers: Map<string, Waiver>;
}

export interface ReportOptions {
  badgePath?: string;
  prCommentPath?: string;
}

export function generateBadgeSvg(passed: boolean): string {
  const status = passed ? "passing" : "failing";
  const color = passed ? "#2ea44f" : "#cb2431";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="168" height="20" role="img" aria-label="Intent Contract: ${status}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="168" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="102" height="20" fill="#555"/>
    <rect x="102" width="66" height="20" fill="${color}"/>
    <rect width="168" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="520" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">Intent Contract</text>
    <text x="520" y="140" transform="scale(.1)" fill="#fff">Intent Contract</text>
    <text aria-hidden="true" x="1340" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">${status}</text>
    <text x="1340" y="140" transform="scale(.1)" fill="#fff">${status}</text>
  </g>
</svg>
`;
}

export function generatePrCommentMarkdown(ctx: ReportContext): string {
  const activeFindings = ctx.findings.filter((f) => {
    const w = ctx.waivers.get(f.id);
    return !w || !isWaiverActive(w);
  });
  const activeErrors = activeFindings.filter((f) => f.severity === "error");
  const isCompliant = activeErrors.length === 0;

  return `## 🛡️ Intent Contract CI Report: ${isCompliant ? "✅ PASSED" : "❌ FAILED"}

[![Intent Contract: ${isCompliant ? "passing" : "failing"}](https://img.shields.io/badge/Intent%20Contract-${isCompliant ? "passing-success" : "failing-critical"}.svg)](#)

- **Contract**: \`${ctx.contract.name}\` — *${escapeMd(ctx.contract.intent)}*
- **Modified Files**: \`${ctx.changes.length}\`
- **Active Errors**: \`${activeErrors.length}\`
- **Active Warnings**: \`${activeFindings.length - activeErrors.length}\`
- **Waivers Granted**: \`${ctx.waivers.size}\`

${activeFindings.length === 0 ? "> 🎉 **All changesets strictly satisfy task scope and safety guardrails.**" : `
### ⚠️ Outstanding Violations
| Severity | Detector | File | Message |
|:---:|---|---|---|
${activeFindings.slice(0, 10).map((f) => `| ${f.severity === "error" ? "🛑 Error" : "⚠️ Warning"} | \`${f.detector}\` | \`${f.file}${f.line ? `:${f.line}` : ""}\` | ${escapeMd(f.message)} |`).join("\n")}
${activeFindings.length > 10 ? `\n*... and ${activeFindings.length - 10} more findings. Inspect the full report for details.*` : ""}
`}
`;
}

export async function generateComplianceReport(ctx: ReportContext, options?: ReportOptions): Promise<string> {
  const reportsDir = path.join(ctx.root, ".intent", "reports");
  await fs.mkdir(reportsDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const fileDate = timestamp.replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `compliance-report-${fileDate}.md`);

  const activeFindings = ctx.findings.filter((f) => {
    const w = ctx.waivers.get(f.id);
    return !w || !isWaiverActive(w);
  });
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

  // Dimension evaluations (D5)
  const symbolChecksConfigured = Boolean(ctx.contract.scope.modify_symbols && ctx.contract.scope.modify_symbols.length > 0);
  const symbolStatus = !symbolChecksConfigured ? "⚪ Not Configured" : (symbolViolations.length === 0 ? "✅ PASS" : "❌ FAIL");
  const symbolOutcome = !symbolChecksConfigured
    ? "No symbol boundaries specified (file-level scope active)"
    : (symbolViolations.length === 0 ? "All modified functions and symbols match approved symbol scope" : `${symbolViolations.length} unapproved symbol modification(s)`);

  const forbidList = ctx.contract.forbid as string[];
  const testChecksEnabled = forbidList.includes("test_weakening") || forbidList.includes("tautological_tests");
  const testStatus = !testChecksEnabled ? "⚪ Not Evaluated" : (testViolations.length === 0 ? "✅ PASS" : "❌ FAIL");
  const testOutcome = !testChecksEnabled
    ? "Test weakening checks disabled in contract forbid list"
    : (testViolations.length === 0 ? "Zero assertion deletions, matcher downgrades, or skipped tests" : `${testViolations.length} test weakening attempt(s) detected`);

  const depChecksEnabled = forbidList.includes("dependencies") || forbidList.includes("new_dependencies");
  const depStatus = !depChecksEnabled ? "⚪ Not Evaluated" : (depViolations.length === 0 ? "✅ PASS" : "❌ FAIL");
  const depOutcome = !depChecksEnabled
    ? "Dependency checks disabled in contract forbid list"
    : (depViolations.length === 0 ? "Zero unvetted package manifests or malicious scripts added" : `${depViolations.length} dependency risk(s) flagged`);

  let archStatus: string;
  let archOutcome: string;
  if (!ctx.contract.architecture?.diagram) {
    archStatus = "⚪ Not Configured";
    archOutcome = "Architecture diagram not configured for this contract";
  } else if (!ctx.contract.forbid.includes("architecture_drift")) {
    archStatus = "⚪ Not Evaluated";
    archOutcome = "Architecture drift check disabled in contract forbid list";
  } else {
    archStatus = archViolations.length === 0 ? "✅ PASS" : "❌ FAIL";
    archOutcome = archViolations.length === 0 ? "Zero unauthorized cross-module imports detected against policy diagram" : `${archViolations.length} architectural boundary breach(es)`;
  }

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
| **AST Symbol Scope** | ${symbolStatus} | ${symbolOutcome} |
| **Test Fidelity (Anti-Weakening)** | ${testStatus} | ${testOutcome} |
| **Supply-Chain Security** | ${depStatus} | ${depOutcome} |
| **Architectural Boundaries** | ${archStatus} | ${archOutcome} |

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
  const isReadOnlyViolation = scopeViolations.some((f) => f.file === file && f.rule === "read_only");
  const isOutsideModifyViolation = scopeViolations.some((f) => f.file === file && f.rule === "outside_modify");
  let scopeStatus = "🛡️ In-Scope";
  if (isReadOnlyViolation) {
    scopeStatus = "🔒 Read-Only";
  } else if (isOutsideModifyViolation) {
    scopeStatus = "⚠️ Out of Scope";
  } else if (matchesPatterns(file, ctx.contract.scope.read_only)) {
    scopeStatus = "🔒 Read-Only";
  } else if (!matchesPatterns(file, ctx.contract.scope.modify)) {
    scopeStatus = "⚠️ Out of Scope";
  }
  return `| ${statusIcon} | \`${file}\` | ${scopeStatus} | ${findingsBadge} |`;
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
| Finding ID | Waiver Reason | Expiration / TTL | Authorized Timestamp |
|---|---|---|---|
${Array.from(ctx.waivers.values()).map((w) => {
  const status = w.expires_at
    ? (Date.now() > Date.parse(w.expires_at) ? `⚠️ Expired (\`${w.expires_at}\`)` : `Active (Expires: \`${w.expires_at}\`)`)
    : "Permanent";
  return `| \`${w.id.slice(0, 12)}...\` | ${escapeMd(w.reason)} | ${status} | \`${w.timestamp}\` |`;
}).join("\n")}
`}

---

## 6. Cryptographic Audit Seal

\`\`\`
Algorithm: SHA-1 / SHA-256 Git Tree Hash
Policy Tree: ${policyTreeHash(ctx.session)}
Baseline Snapshot: ${ctx.session.baselineTreeHash}
Verification Timestamp: ${timestamp}
Audited by: Intent Contract Engine
\`\`\`
`;

  await fs.writeFile(reportPath, markdown, "utf8");

  if (options?.badgePath) {
    await fs.mkdir(path.dirname(options.badgePath), { recursive: true });
    await fs.writeFile(options.badgePath, generateBadgeSvg(isCompliant), "utf8");
  }

  if (options?.prCommentPath) {
    await fs.mkdir(path.dirname(options.prCommentPath), { recursive: true });
    await fs.writeFile(options.prCommentPath, generatePrCommentMarkdown(ctx), "utf8");
  }

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

