import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs/promises";
import { createDefaultContract, ensureIntentMetadataIgnored } from "./contract/template";
import { discoverContracts, loadContract, parseContract } from "./contract/loader";
import type { Contract } from "./contract/schema";
import { detectFindingsForWorkspace } from "./detectors";
import { analyzeArchitectureDrift, renderArchitectureDriftDiagram } from "./detectors/architectureDrift";
import type { FileChange, Finding } from "./detectors/types";
import { diffTrees } from "./git/diff";
import { captureBaseline, createWorkingTreeSnapshot, releaseBaseline } from "./git/snapshot";
import { findRepositoryRoot, gitBuffer } from "./git/cli";
import { removeSession, readSession, writeSession, type ContractSession } from "./state/session";
import { readWaivers, type Waiver } from "./state/waivers";
import { writeViolationSummary } from "./state/violations";
import { copyFindingsForAgent, openFindingDiff, revertFindingFile, waiveFinding, type ActionContext } from "./ui/actions";
import { BaselineContentProvider } from "./ui/baselineContentProvider";
import { FindingDiagnostics } from "./ui/diagnostics";
import { ContractStatusBar } from "./ui/statusBar";
import { FindingsTreeProvider } from "./ui/treeView";
import { toRepoPath } from "./util/paths";
import { configureAgentIntegrations, type AgentIntegration } from "./config/agentConfig";

let output: vscode.OutputChannel;
let root: string | undefined;
let session: ContractSession | undefined;
let contract: Contract | undefined;
let findings: Finding[] = [];
let changes: FileChange[] = [];
let waivers = new Map<string, Waiver>();
let checkRunning = false;
let checkQueued = false;
let checkTimer: ReturnType<typeof setTimeout> | undefined;
let statusBar: ContractStatusBar;
let treeProvider: FindingsTreeProvider;
let diagnostics: FindingDiagnostics;
let architecturePreviewText = "";
let architecturePreviewEmitter: vscode.EventEmitter<vscode.Uri>;
let architecturePreviewUri: vscode.Uri;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Intent Contract");
  statusBar = new ContractStatusBar();
  treeProvider = new FindingsTreeProvider();
  diagnostics = new FindingDiagnostics();
  context.subscriptions.push(output, statusBar, treeProvider, diagnostics);
  architecturePreviewEmitter = new vscode.EventEmitter<vscode.Uri>();
  architecturePreviewUri = vscode.Uri.parse("intent-contract-architecture:/architecture-drift-preview.md");
  context.subscriptions.push(
    architecturePreviewEmitter,
    vscode.workspace.registerTextDocumentContentProvider("intent-contract-architecture", {
      onDidChange: architecturePreviewEmitter.event,
      provideTextDocumentContent: () => architecturePreviewText
    })
  );

  context.subscriptions.push(vscode.window.registerTreeDataProvider("intentContractFindings", treeProvider));

  const provider = new BaselineContentProvider(
    () => root,
    () => session
  );
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("intent-baseline", provider));

  const actionContext: ActionContext = {
    getRoot: () => root,
    getSession: () => session,
    getChanges: () => changes,
    getFindings: () => findings,
    getWaivers: () => waivers,
    getAllowExceptions: () => contract?.allow_exceptions ?? false,
    refresh: () => runCheck()
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("intentContract.start", () => startContract()),
    vscode.commands.registerCommand("intentContract.stop", () => stopContract()),
    vscode.commands.registerCommand("intentContract.recheck", () => runCheck()),
    vscode.commands.registerCommand("intentContract.createTemplate", () => createTemplate()),
    vscode.commands.registerCommand("intentContract.copyViolations", () => copyFindingsForAgent(actionContext)),
    vscode.commands.registerCommand("intentContract.configureAgents", () => configureAgents(context)),
    vscode.commands.registerCommand("intentContract.exportArchitectureDrift", () => exportArchitectureDriftDiagram()),
    vscode.commands.registerCommand("intentContract.openDiff", async (value?: unknown) => openFindingDiff(unwrapFinding(value) ?? await chooseCurrentFinding(), actionContext)),
    vscode.commands.registerCommand("intentContract.revertFile", async (value?: unknown) => revertFindingFile(unwrapFinding(value) ?? await chooseCurrentFinding(), actionContext)),
    vscode.commands.registerCommand("intentContract.waiveFinding", (value?: unknown) => waiveFinding(unwrapFinding(value), actionContext)),
    vscode.commands.registerCommand("intentContract.statusClick", async () => {
      if (!session) return vscode.commands.executeCommand("intentContract.start");
      try {
        return await vscode.commands.executeCommand("intentContractFindings.focus");
      } catch {
        return await vscode.commands.executeCommand("workbench.view.explorer");
      }
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const scheduleCheck = (): void => {
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      checkTimer = undefined;
      void runCheck();
    }, 800);
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate((uri) => { if (!isIgnored(uri)) scheduleCheck(); }),
    watcher.onDidChange((uri) => { if (!isIgnored(uri)) scheduleCheck(); }),
    watcher.onDidDelete((uri) => { if (!isIgnored(uri)) scheduleCheck(); }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!isIgnored(document.uri)) scheduleCheck();
    }),
    new vscode.Disposable(() => {
      if (checkTimer) clearTimeout(checkTimer);
    })
  );

  await restoreSession();
}

export function deactivate(): void {
  if (checkTimer) clearTimeout(checkTimer);
}

async function startContract(): Promise<void> {
  const repoRoot = await workspaceRepositoryRoot();
  if (!repoRoot) return;
  const files = await discoverContracts(repoRoot);
  if (files.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      "No contract YAML files were found in .intent/.",
      "Create Contract From Template"
    );
    if (choice) await createTemplate();
    return;
  }
  let selected = files[0];
  if (files.length > 1) {
    const options = await Promise.all(files.map(async (filePath) => {
      try {
        const loaded = await loadContract(filePath);
        return { label: loaded.name, description: path.relative(repoRoot, filePath).replace(/\\/g, "/"), filePath };
      } catch {
        return { label: path.basename(filePath), description: "Invalid contract", filePath };
      }
    }));
    const choice = await vscode.window.showQuickPick(options, { placeHolder: "Choose the contract to start" });
    if (!choice) return;
    selected = choice.filePath;
  }

  let selectedContract: Contract;
  try {
    selectedContract = await loadContract(selected);
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error));
    return;
  }

  if (session?.baselineRef) await releaseBaseline(root ?? repoRoot, session.baselineRef);
  root = repoRoot;
  contract = selectedContract;
  await ensureIntentMetadataIgnored(repoRoot);
  const snapshot = await captureBaseline(repoRoot);
  session = {
    ...snapshot,
    activeContract: toRepoPath(path.relative(repoRoot, selected))
  };
  contract = await loadContractFromBaseline(repoRoot, session);
  await writeSession(repoRoot, session);
  void vscode.window.showInformationMessage(`Started contract “${selectedContract.name}” from the current working tree.`);
  await runCheck();
}

async function stopContract(): Promise<void> {
  if (!root || !session) {
    statusBar.update(undefined, []);
    return;
  }
  await releaseBaseline(root, session.baselineRef);
  await removeSession(root);
  try {
    await fs.unlink(path.join(root, ".intent", ".violations.md"));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  session = undefined;
  contract = undefined;
  changes = [];
  findings = [];
  waivers = new Map();
  diagnostics.update(undefined, []);
  treeProvider.setState(false, [], waivers);
  statusBar.update(undefined, []);
  void vscode.window.showInformationMessage("Stopped the active Intent Contract.");
}

async function createTemplate(): Promise<void> {
  const repoRoot = await workspaceRepositoryRoot();
  if (!repoRoot) return;
  try {
    const filePath = await createDefaultContract(repoRoot);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document);
    void vscode.window.showInformationMessage("Created .intent/default.yaml. Edit it, then start the contract.");
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error));
  }
}

async function configureAgents(context: vscode.ExtensionContext): Promise<void> {
  const repoRoot = await workspaceRepositoryRoot();
  if (!repoRoot) return;
  const items: Array<vscode.QuickPickItem & { integration: AgentIntegration }> = [
    { label: "Cursor", description: ".cursor/mcp.json + .cursor/rules/intent-contract.mdc", picked: true, integration: "cursor" },
    { label: "Google Antigravity", description: ".agents/mcp_config.json + .agents/rules/intent-contract.md", picked: true, integration: "antigravity" },
    { label: "Claude Code", description: ".mcp.json + CLAUDE.md section", picked: true, integration: "claude" },
    { label: "GitHub Copilot", description: ".mcp.json + .github/copilot-instructions.md", picked: true, integration: "copilot" },
    { label: "Git Pre-Commit Hook", description: ".git/hooks/pre-commit", picked: true, integration: "precommit" }
  ];
  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: "Choose the AI agents and Git hook to configure",
    ignoreFocusOut: true
  });
  if (!selected?.length) return;
  try {
    const configured = await configureAgentIntegrations(
      repoRoot,
      context.extensionPath,
      selected.map((item) => item.integration)
    );
    void vscode.window.showInformationMessage("Configured " + configured.join(", ") + ".");
  } catch (error) {
    void vscode.window.showErrorMessage("Could not configure AI agents: " + errorMessage(error));
  }
}

async function runCheck(): Promise<void> {
  checkQueued = true;
  if (checkRunning) return;
  checkRunning = true;
  try {
    while (checkQueued) {
      checkQueued = false;
      await performCheck();
    }
  } finally {
    checkRunning = false;
  }
}

async function performCheck(): Promise<void> {
  if (!root) {
    treeProvider?.setState(false, [], new Map());
    statusBar?.update(undefined, []);
    return;
  }
  const savedSession = await readSession(root);
  if (!savedSession) {
    if (session) {
      session = undefined;
      contract = undefined;
      changes = [];
      findings = [];
      waivers = new Map();
      diagnostics.update(undefined, []);
      treeProvider?.setState(false, [], new Map());
      statusBar?.update(undefined, []);
    }
    return;
  }
  if (!session || !contract || session.baselineTreeHash !== savedSession.baselineTreeHash || session.activeContract !== savedSession.activeContract) {
    session = savedSession;
    contract = await loadContractFromBaseline(root, savedSession);
  }
  try {
    const currentTreeHash = await createWorkingTreeSnapshot(root);
    const diff = await diffTrees(root, session.baselineTreeHash, currentTreeHash);
    const nextFindings = await detectFindingsForWorkspace(root, session.baselineTreeHash, diff, contract, session.activeContract);
    const nextWaivers = await readWaivers(root);
    const active = nextFindings.filter((finding) => !nextWaivers.has(finding.id));
    changes = diff.changes;
    findings = nextFindings;
    waivers = nextWaivers;
    diagnostics.update(root, active);
    treeProvider.setState(true, nextFindings, nextWaivers);
    statusBar.update(contract.name, active);
    await writeViolationSummary(root, nextFindings, nextWaivers);
    output.appendLine(`[${new Date().toISOString()}] Checked ${diff.changes.length} changed file(s); ${active.length} active finding(s).`);
  } catch (error) {
    const message = `Intent Contract check failed: ${errorMessage(error)}`;
    output.appendLine(message);
    void vscode.window.showErrorMessage(message);
  }
}

async function exportArchitectureDriftDiagram(): Promise<void> {
  if (!root || !session || !contract) {
    void vscode.window.showWarningMessage("Start an Intent Contract before exporting its architecture drift diagram.");
    return;
  }
  if (!contract.architecture || !contract.forbid.includes("architecture_drift")) {
    void vscode.window.showWarningMessage("The active contract does not enable architecture_drift.");
    return;
  }
  await runCheck();
  try {
    const currentTreeHash = await createWorkingTreeSnapshot(root);
    const currentDiff = await diffTrees(root, session.baselineTreeHash, currentTreeHash);
    changes = currentDiff.changes;
    const analysis = await analyzeArchitectureDrift(
      root,
      session.baselineTreeHash,
      currentDiff,
      contract,
      session.activeContract
    );
    if (!analysis.graph.nodes.size) {
      throw new Error(analysis.findings[0]?.message ?? "The architecture diagram contains no recognized nodes.");
    }
    const diagram = renderArchitectureDriftDiagram(analysis.graph, analysis.violations, contract.architecture.diagram);
    const outputPath = path.join(root, ".intent", ".architecture-drift.mmd");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, diagram, "utf8");

    const fence = String.fromCharCode(96).repeat(3);
    architecturePreviewText = "# Architecture drift report\n\nOfficial policy: " + contract.architecture.diagram +
      "\n\n" + fence + "mermaid\n" + diagram + fence + "\n";
    architecturePreviewEmitter.fire(architecturePreviewUri);
    try {
      await vscode.commands.executeCommand("markdown.showPreview", architecturePreviewUri, vscode.ViewColumn.Beside);
    } catch {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(outputPath));
      await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
    }
    void vscode.window.showInformationMessage(
      "Exported " + analysis.violations.length + " architecture violation(s) to .intent/.architecture-drift.mmd."
    );
  } catch (error) {
    void vscode.window.showErrorMessage("Could not export the architecture drift diagram: " + errorMessage(error));
  }
}

async function restoreSession(): Promise<void> {
  const repoRoot = await workspaceRepositoryRoot(false);
  if (!repoRoot) return;
  root = repoRoot;
  try {
    const savedSession = await readSession(repoRoot);
    if (!savedSession) {
      statusBar.update(undefined, []);
      treeProvider.setState(false, [], new Map());
      return;
    }
    session = savedSession;
    contract = await loadContractFromBaseline(repoRoot, savedSession);
    await runCheck();
  } catch (error) {
    output.appendLine(`Could not restore the saved contract session: ${errorMessage(error)}`);
    void vscode.window.showWarningMessage(`Could not restore the saved Intent Contract: ${errorMessage(error)}`);
  }
}

async function workspaceRepositoryRoot(showError = true): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    if (showError) void vscode.window.showErrorMessage("Open a Git repository folder before starting an Intent Contract.");
    return undefined;
  }
  try {
    return await findRepositoryRoot(folder.uri.fsPath);
  } catch {
    if (showError) void vscode.window.showErrorMessage("The current workspace is not inside a Git repository.");
    return undefined;
  }
}

function isIgnored(uri: vscode.Uri): boolean {
  if (!root || uri.scheme !== "file") return true;
  const relative = path.relative(root, uri.fsPath).replace(/\\/g, "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return true;
  return relative === ".intent/.violations.md" ||
    relative.split("/").some((part) => part === ".git" || part === "node_modules");
}

async function chooseCurrentFinding(): Promise<Finding | undefined> {
  const active = findings.filter((finding) => !waivers.has(finding.id));
  if (active.length === 1) return active[0];
  if (active.length === 0) {
    void vscode.window.showInformationMessage("There are no active findings to open or revert.");
    return undefined;
  }
  const items = active.map((finding) => ({
    label: finding.file,
    description: `${finding.severity} · ${finding.detector} · ${finding.message}`,
    finding
  }));
  return (await vscode.window.showQuickPick(items, { placeHolder: "Choose a finding" }))?.finding;
}

function unwrapFinding(value: unknown): Finding | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const finding = "finding" in candidate ? candidate.finding : candidate;
  if (typeof finding !== "object" || finding === null) return undefined;
  const fields = finding as Record<string, unknown>;
  if (typeof fields.id !== "string" || typeof fields.file !== "string" || typeof fields.message !== "string") return undefined;
  return finding as Finding;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadContractFromBaseline(repoRoot: string, savedSession: ContractSession): Promise<Contract> {
  const buffer = await gitBuffer(repoRoot, [
    "cat-file", "blob", `${savedSession.baselineTreeHash}:${savedSession.activeContract}`
  ]);
  return parseContract(buffer.toString("utf8"), path.basename(savedSession.activeContract));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
