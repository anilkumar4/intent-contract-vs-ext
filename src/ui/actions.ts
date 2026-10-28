import * as vscode from "vscode";
import { revertFileToBaseline } from "../git/revert";
import type { FileChange, Finding } from "../detectors/types";
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
    query: `tree=${session.baselineTreeHash}`
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
  await revertFileToBaseline(root, session.baselineTreeHash, change);
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
  const reason = await vscode.window.showInputBox({
    prompt: `Why should this finding be waived? (${selected.file})`,
    placeHolder: "Record the reason for this exception",
    ignoreFocusOut: true,
    validateInput: (value) => value.trim().length === 0 ? "A reason is required." : undefined
  });
  if (!reason?.trim()) return;
  await addWaiver(root, { id: selected.id, reason: reason.trim(), timestamp: new Date().toISOString() });
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
