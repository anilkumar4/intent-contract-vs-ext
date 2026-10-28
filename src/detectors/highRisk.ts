import path from "node:path";
import picomatch from "picomatch";
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
      const rule = highRiskRule(file, contract);
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

export function highRiskRule(file: string, contract?: Contract): string | undefined {
  const normalized = file.replace(/\\/g, "/");
  const basename = path.posix.basename(normalized);

  if (contract?.high_risk?.exclude?.some((pattern) => picomatch.isMatch(normalized, pattern.replace(/\\/g, "/"), { dot: true }))) {
    return undefined;
  }
  if (contract?.high_risk?.include?.some((pattern) => picomatch.isMatch(normalized, pattern.replace(/\\/g, "/"), { dot: true }))) {
    return "custom_high_risk";
  }

  if (normalized.startsWith(".github/workflows/")) return "ci_workflow";
  if (normalized === ".github/CODEOWNERS" || normalized === "CODEOWNERS" || normalized === "docs/CODEOWNERS") return "codeowners";
  if (normalized.startsWith(".github/actions/") || /^\.github\/.*action\.ya?ml$/i.test(normalized)) return "ci_workflow";
  if (normalized === ".github/dependabot.yml" || normalized === ".github/dependabot.yaml") return "dependabot";
  if (normalized === ".gitlab-ci.yml") return "gitlab_ci";
  if (basename === "Jenkinsfile" || basename.startsWith("Jenkinsfile.")) return "jenkins_ci";
  if (normalized === "azure-pipelines.yml" || normalized === "azure-pipelines.yaml") return "azure_pipelines";
  if (normalized.startsWith(".circleci/")) return "circleci";
  if (basename.endsWith(".tf") || basename.endsWith(".tfvars") || basename.endsWith(".tfvars.json")) return "terraform";
  if (basename.endsWith(".bicep")) return "bicep";
  if (normalized.startsWith("k8s/") || normalized.startsWith("kubernetes/") || /\.(?:k8s|kubernetes)\.ya?ml$/i.test(basename)) return "kubernetes";
  if (basename === ".npmrc") return "npmrc";
  if (normalized === ".vscode/tasks.json") return "vscode_tasks";
  if (normalized === ".vscode/settings.json") return "vscode_settings";
  if (normalized.startsWith(".husky/")) return "git_hooks";
  if (normalized === ".mcp.json" || normalized === ".cursor/mcp.json" || normalized === ".vscode/mcp.json") return "mcp_config";
  if (normalized.startsWith(".cursor/rules/") || normalized.endsWith(".mdc")) return "agent_rules";
  if (normalized === "CLAUDE.md" || normalized === "AGENTS.md" || normalized === ".github/copilot-instructions.md") return "agent_instructions";
  if (normalized === ".cursorrules") return "agent_rules";
  if (normalized.startsWith(".agents/")) return "agent_config";
  if (normalized.split("/").some((part) => part.startsWith(".env"))) return "environment_file";
  if (/^Dockerfile/i.test(basename)) return "dockerfile";
  if (/^docker-compose/i.test(basename)) return "docker_compose";
  if (isLockfile(normalized)) return "lockfile";
  return undefined;
}
