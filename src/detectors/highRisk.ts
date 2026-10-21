import path from "node:path";
import type { Contract, Finding, FileChange } from "./types";
import { makeFinding } from "./finding";
import { isLockfile } from "./dependencies";
import { changedLine, diffEvidence } from "./diffEvidence";

export function detectHighRiskFiles(changes: FileChange[], contract: Contract): Finding[] {
  if (!contract.forbid.includes("high_risk_files")) return [];
  const findings: Finding[] = [];
  for (const change of changes) {
    const paths = change.status === "R"
      ? [change.oldFile, change.newFile].filter((value): value is string => Boolean(value))
      : [change.file];
    for (const file of new Set(paths)) {
      const rule = highRiskRule(file);
      if (!rule) continue;
      findings.push(makeFinding(
        "high_risk_files", file, rule, diffEvidence(change), "error",
        `High-risk file changed: ${file}`,
        changedLine(change),
        "Review this high-risk change with the contract owner and restore the baseline unless the change was explicitly approved."
      ));
    }
  }
  return findings;
}

function highRiskRule(file: string): string | undefined {
  const normalized = file.replace(/\\/g, "/");
  const basename = path.posix.basename(normalized);
  if (normalized.startsWith(".github/workflows/")) return "ci_workflow";
  if (normalized === ".gitlab-ci.yml") return "gitlab_ci";
  if (normalized === ".cursorrules") return "agent_rules";
  if (normalized.startsWith(".agents/")) return "agent_config";
  if (normalized.split("/").some((part) => part.startsWith(".env"))) return "environment_file";
  if (/^Dockerfile/i.test(basename)) return "dockerfile";
  if (/^docker-compose/i.test(basename)) return "docker_compose";
  if (basename.endsWith(".tf")) return "terraform";
  if (isLockfile(normalized)) return "lockfile";
  return undefined;
}
