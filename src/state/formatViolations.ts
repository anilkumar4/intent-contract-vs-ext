import type { Finding } from "../detectors/types";

export function formatFindingsForAgent(findings: Finding[]): string {
  if (findings.length === 0) return "Intent Contract detected no active violations.";

  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  const lines = [
    "Intent Contract remediation request",
    "",
    "Treat the findings below as actionable contract requirements. Inspect the baseline and current diff, make the smallest compliant correction, and do not weaken tests to make an implementation change pass.",
    ""
  ];
  appendGroup(lines, "ERROR (Must Fix)", errors);
  appendGroup(lines, "WARNING (Review/Revert)", warnings);
  return lines.join("\n").trimEnd();
}

function appendGroup(lines: string[], title: string, findings: Finding[]): void {
  lines.push(`## ${title}`, "");
  if (findings.length === 0) {
    lines.push("None.", "");
    return;
  }
  for (const finding of findings) {
    const location = finding.line ? `${finding.file}:${finding.line}` : `${finding.file} (line unavailable)`;
    lines.push(
      `### ${location} — ${finding.rule ?? finding.detector}`,
      `- Finding: ${finding.message}`,
      "- Evidence:",
      "```diff",
      finding.evidence,
      "```",
      `- Required action: ${finding.remediation ?? defaultRemediation(finding)}`,
      ""
    );
  }
}

function defaultRemediation(finding: Finding): string {
  if (finding.detector === "scope" && finding.rule === "read_only") {
    return "Restore the file to the captured baseline or obtain explicit approval to change this read-only path.";
  }
  if (finding.detector === "scope") {
    return "Move the change into scope.modify or obtain explicit approval to expand the contract scope.";
  }
  if (finding.detector === "dependencies") {
    return "Revert the dependency or lockfile change unless adding or updating it is required and explicitly approved.";
  }
  if (finding.detector === "high_risk_files") {
    return "Review the high-risk change with the contract owner and restore the baseline unless it was explicitly approved.";
  }
  return "Review the baseline and current diff, then correct or revert this change to comply with the task contract.";
}
