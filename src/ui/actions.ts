import path from "node:path";
import * as vscode from "vscode";
import { revertFileToBaseline } from "../git/revert";
import type { FileChange, Finding } from "../detectors/types";
import { policyTreeHash } from "../runtime/contracts";
import type { ContractSession } from "../state/session";
import { addWaiver, type Waiver } from "../state/waivers";
import { formatFindingsForAgent } from "../state/formatViolations";
import { resolveRepoFile } from "../util/paths";

export interface ActionContext {
  getRoot(): string | undefined;
  getSession(): ContractSession | undefined;
  getChanges(): FileChange[];
  getFindings(): Finding[];
  getWaivers(): Map<string, Waiver>;
  getAllowExceptions(): boolean;
  refresh(): Promise<void>;
}

export async function openFindingDiff(finding: Finding | undefined, context: ActionContext): Promise<void> {
  if (!finding) return;
  const root = context.getRoot();
  const session = context.getSession();
  if (!root || !session) return;
  const change = findChange(finding, context.getChanges());
  if (!change) {
    void vscode.window.showInformationMessage("No current diff is available for this finding.");
    return;
  }
  const repoPath = change.status === "R" && finding.file === change.oldFile
    ? change.oldFile
    : change.newFile ?? change.file;
  const baselineUri = vscode.Uri.from({
    scheme: "intent-baseline",
    path: `/${repoPath}`,
    query: `tree=${policyTreeHash(session)}`
  });
  const currentPath = resolveRepoFile(root, repoPath);
  const currentUri = vscode.Uri.file(currentPath);
  await vscode.commands.executeCommand("vscode.diff", baselineUri, currentUri, `${repoPath} (Intent baseline)`);
}

export async function revertFindingFile(finding: Finding | undefined, context: ActionContext): Promise<void> {
  if (!finding) return;
  const root = context.getRoot();
  const session = context.getSession();
  if (!root || !session) return;
  const change = findChange(finding, context.getChanges());
  if (!change) {
    void vscode.window.showInformationMessage("No current file change is available to revert.");
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Restore ${change.file} to the captured baseline? This writes the baseline bytes to the working tree.`,
    { modal: true },
    "Restore File"
  );
  if (confirm !== "Restore File") return;
  await revertFileToBaseline(root, policyTreeHash(session), change);
  await context.refresh();
  void vscode.window.showInformationMessage(`Restored ${change.file} to the Intent Contract baseline.`);
}

export async function waiveFinding(finding: Finding | undefined, context: ActionContext): Promise<void> {
  const root = context.getRoot();
  if (!root) return;
  const session = context.getSession();
  if (!session) {
    void vscode.window.showWarningMessage("No active Intent Contract session was found. Start a contract first.");
    return;
  }
  if (!context.getAllowExceptions()) {
    void vscode.window.showWarningMessage("This contract does not allow exceptions.");
    return;
  }
  const selected = finding ?? await chooseFinding(context.getFindings(), context.getWaivers());
  if (!selected) return;
  if (context.getWaivers().has(selected.id)) {
    void vscode.window.showInformationMessage("This finding is already waived.");
    return;
  }
  const suggestions = getContextualWaiverTemplates(selected);
  const items: Array<vscode.QuickPickItem & { template?: string; isCustom?: boolean }> = [
    ...suggestions.map((s) => ({
      label: s.label,
      description: s.description,
      detail: s.template,
      template: s.template
    })),
    {
      label: "$(edit) Enter a custom reason...",
      description: "Type an explicit custom explanation",
      isCustom: true
    }
  ];

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Select justification for [${selected.detector}] in ${path.basename(selected.file)}`
  });
  if (!pick) return;

  const initialReason = pick.template ?? "";
  const input = await vscode.window.showInputBox({
    prompt: `Confirm or refine justification for ${selected.file}:`,
    value: initialReason,
    placeHolder: "Provide waiver reason (e.g., ticket ID, approval details)",
    ignoreFocusOut: true,
    validateInput: (value) => value.trim().length === 0 ? "A reason is required." : undefined
  });
  if (!input?.trim()) return;
  const reason = input.trim();

  const ttlOptions = [
    { label: "Permanent", description: "Never expires", ms: 0 },
    { label: "1 Hour", description: "Temporary exception for quick experiment", ms: 3600 * 1000 },
    { label: "24 Hours (1 Day)", description: "Auto-reopens after 24 hours", ms: 24 * 3600 * 1000 },
    { label: "7 Days (1 Week)", description: "Standard sprint cycle exception", ms: 7 * 24 * 3600 * 1000 },
    { label: "30 Days", description: "Monthly audit cycle exception", ms: 30 * 24 * 3600 * 1000 }
  ];

  const ttlPick = await vscode.window.showQuickPick(ttlOptions, {
    placeHolder: "Select waiver duration / time-to-live (TTL)"
  });
  if (!ttlPick) return;

  const timestamp = new Date().toISOString();
  let expires_at: string | undefined;
  if (ttlPick.ms > 0) {
    expires_at = new Date(Date.now() + ttlPick.ms).toISOString();
  }

  await addWaiver(root, {
    id: selected.id,
    reason: reason.trim(),
    timestamp,
    ...(expires_at ? { expires_at } : {})
  });
  await context.refresh();
}

export async function copyFindingsForAgent(context: ActionContext): Promise<void> {
  const active = context.getFindings().filter((finding) => !context.getWaivers().has(finding.id));
  await vscode.env.clipboard.writeText(formatFindingsForAgent(active));
  void vscode.window.showInformationMessage("Intent Contract findings copied to the clipboard.");
}

function findChange(finding: Finding, changes: FileChange[]): FileChange | undefined {
  return changes.find((change) => change.file === finding.file || change.oldFile === finding.file || change.newFile === finding.file);
}

async function chooseFinding(findings: Finding[], waivers: Map<string, Waiver>): Promise<Finding | undefined> {
  const options = findings
    .filter((finding) => !waivers.has(finding.id))
    .map((finding) => ({ label: finding.file, description: `${finding.severity} · ${finding.detector} · ${finding.message}`, finding }));
  if (options.length === 0) {
    void vscode.window.showInformationMessage("There are no active findings to waive.");
    return undefined;
  }
  return (await vscode.window.showQuickPick(options, { placeHolder: "Choose a finding to waive" }))?.finding;
}

export interface WaiverSuggestion {
  label: string;
  description: string;
  template: string;
}

export function getContextualWaiverTemplates(finding: Finding): WaiverSuggestion[] {
  const normFile = finding.file.replace(/\\/g, "/").toLowerCase();

  switch (finding.detector) {
    case "high_risk_files": {
      if (normFile.includes(".github/") || normFile.includes(".gitlab") || normFile.includes("jenkins") || normFile.includes("workflow")) {
        return [
          {
            label: "Approved CI/CD workflow update",
            description: "Pipeline or automation workflow change",
            template: `Approved CI/CD workflow update for ${finding.file}`
          },
          {
            label: "Emergency pipeline/build fix",
            description: "Temporary build fix pending full review",
            template: `Emergency pipeline fix in ${finding.file}`
          },
          {
            label: "Authorized deployment/infrastructure update",
            description: "Approved DevOps or infrastructure change",
            template: `Authorized infrastructure update in ${finding.file}`
          }
        ];
      }
      if (normFile.includes(".env") || normFile.includes("secret") || normFile.includes("cert") || normFile.includes("auth")) {
        return [
          {
            label: "Authorized security/credential configuration",
            description: "Reviewed and approved sensitive security change",
            template: `Authorized security configuration update in ${finding.file}`
          },
          {
            label: "Environment configuration update",
            description: "Approved runtime/environment variable update",
            template: `Approved environment update in ${finding.file}`
          }
        ];
      }
      return [
        {
          label: "Authorized sensitive path modification",
          description: "Explicitly reviewed critical file change",
          template: `Authorized sensitive file modification in ${finding.file}`
        },
        {
          label: "Approved core configuration change",
          description: "Configuration change reviewed with lead/team",
          template: `Approved core configuration change in ${finding.file}`
        }
      ];
    }
    case "dependencies": {
      return [
        {
          label: "Approved package addition/upgrade",
          description: "Approved dependency addition or version bump",
          template: `Approved dependency addition/update in ${finding.file}`
        },
        {
          label: "Security vulnerability fix",
          description: "Required CVE patch or security advisory upgrade",
          template: `Security patch requiring dependency update in ${finding.file}`
        },
        {
          label: "Development/testing tooling dependency",
          description: "Non-production dependency for tests or build tools",
          template: `Approved dev/tooling dependency addition in ${finding.file}`
        }
      ];
    }
    case "test_weakening":
    case "tautological_tests": {
      return [
        {
          label: "Intentional test suite refactoring",
          description: "Assertion rewritten or test mock overhauled",
          template: `Intentional test suite refactoring in ${finding.file}`
        },
        {
          label: "Assertion update due to requirement change",
          description: "Specification changed expected behavior",
          template: `Approved test update reflecting specification change in ${finding.file}`
        },
        {
          label: "Temporary waiver during feature development",
          description: "Waiver to unblock progress while new tests are authored",
          template: `Temporary test waiver during feature development in ${finding.file}`
        }
      ];
    }
    case "architecture_drift": {
      return [
        {
          label: "Architectural boundary exception for legacy migration",
          description: "Temporary cross-module dependency during transition",
          template: `Architectural boundary exception for legacy migration (${finding.file})`
        },
        {
          label: "Approved cross-module dependency",
          description: "Verified and accepted coupling between modules",
          template: `Approved cross-module dependency in ${finding.file}`
        },
        {
          label: "In-progress architectural decoupling",
          description: "Step in multi-stage refactoring roadmap",
          template: `In-progress refactoring across module boundary (${finding.file})`
        }
      ];
    }
    case "symbol_scope": {
      return [
        {
          label: "Authorized symbol modification",
          description: "Approved change to symbol outside current contract scope",
          template: `Authorized symbol modification outside contracted symbols in ${finding.file}`
        },
        {
          label: "Internal helper / supporting function update",
          description: "Supporting private function modified to serve in-scope task",
          template: `Authorized internal helper update in ${finding.file}`
        }
      ];
    }
    case "scope":
    default: {
      return [
        {
          label: "Approved scope extension",
          description: "Necessary change outside initial contract files",
          template: `Approved scope extension for ${finding.file}`
        },
        {
          label: "Bugfix in supporting file",
          description: "Fixed unexpected issue discovered during primary task",
          template: `Authorized supporting bugfix in ${finding.file}`
        },
        {
          label: "Shared utility/type update",
          description: "Supporting type definition or utility change",
          template: `Approved supporting utility change in ${finding.file}`
        }
      ];
    }
  }
}
