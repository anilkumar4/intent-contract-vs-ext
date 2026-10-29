import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs/promises";
import picomatch from "picomatch";
import { createDefaultContract, ensureIntentMetadataIgnored } from "./contract/template";
import { discoverContracts, loadContract, parseContract } from "./contract/loader";
import type { Contract } from "./contract/schema";
import { detectFindingsForWorkspace } from "./detectors";
import { analyzeArchitectureDrift, renderArchitectureDriftDiagram, type ArchitectureAnalysis } from "./detectors/architectureDrift";
import type { FileChange, Finding } from "./detectors/types";
import { diffTrees } from "./git/diff";
import { captureBaseline, createWorkingTreeSnapshot } from "./git/snapshot";
import { findRepositoryRoot, gitBuffer } from "./git/cli";
import { ensurePolicyBaselineRef, policyTreeHash, releaseSessionBaselineRefs, revertIntentFile, revertOutOfScopeFiles } from "./runtime/contracts";
import { removeSession, readSession, writeSession, type ContractSession } from "./state/session";
import { readWaiversForContract, type Waiver } from "./state/waivers";
import { writeViolationSummary } from "./state/violations";
import { copyFindingsForAgent, openFindingDiff, revertFindingFile, waiveFinding, type ActionContext } from "./ui/actions";
import { BaselineContentProvider } from "./ui/baselineContentProvider";
import { FindingDiagnostics } from "./ui/diagnostics";
import { ContractStatusBar } from "./ui/statusBar";
import { FindingsTreeProvider } from "./ui/treeView";
import { VisualContractBuilderPanel } from "./ui/visualBuilder";
import { MissionControlDashboardPanel } from "./ui/dashboard";
import { ArchitectureInspectorPanel } from "./ui/architectureInspector";
import { addSymbolToScope, addFileToScope, markFileReadOnly } from "./ui/scopeHelpers";
import { IntentContractCodeLensProvider } from "./ui/codeLens";
import { IntentContractCodeActionProvider } from "./ui/quickFix";
import { generateComplianceReport } from "./state/report";
import { syncActiveContractToAgents, clearActiveContractFromAgents } from "./config/agentSync";
import { toRepoPath } from "./util/paths";
import { configureAgentIntegrations, type AgentIntegration } from "./config/agentConfig";

let output: vscode.OutputChannel;
let root: string | undefined;
let session: ContractSession | undefined;
let contract: Contract | undefined;
let findings: Finding[] = [];
let changes: FileChange[] = [];
let waivers = new Map<string, Waiver>();
let latestArchitectureAnalysis: ArchitectureAnalysis | undefined;
let checkRunning = false;
let checkQueued = false;
let queuedResolvers: Array<() => void> = [];
let checkTimer: ReturnType<typeof setTimeout> | undefined;
let statusBar: ContractStatusBar;
let treeProvider: FindingsTreeProvider;
let diagnostics: FindingDiagnostics;
let codeLensProvider: IntentContractCodeLensProvider;
let architecturePreviewText = "";
let architecturePreviewEmitter: vscode.EventEmitter<vscode.Uri>;
let architecturePreviewUri: vscode.Uri;
let extensionContext: vscode.ExtensionContext | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
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

  codeLensProvider = new IntentContractCodeLensProvider(() => ({
    root,
    session,
    contract,
    findings,
    waivers
  }));
  context.subscriptions.push(
    codeLensProvider,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLensProvider),
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new IntentContractCodeActionProvider({
        getRoot: () => root,
        getFindings: () => findings
      }),
      {
        providedCodeActionKinds: IntentContractCodeActionProvider.providedCodeActionKinds
      }
    )
  );

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
    vscode.commands.registerCommand("intentContract.openGuide", () => openVibeCodingGuide(context)),
    vscode.commands.registerCommand("intentContract.visualBuilder", () => {
      return VisualContractBuilderPanel.createOrShow(context.extensionUri, async (name) => {
        await startContractByName(name);
      });
    }),
    vscode.commands.registerCommand("intentContract.openWalkthrough", () => {
      return vscode.commands.executeCommand("workbench.action.openWalkthrough", "anilkumar4.intent-contract#intentContractWalkthrough", false);
    }),
    vscode.commands.registerCommand("intentContract.openDashboard", () => {
      return MissionControlDashboardPanel.createOrShow(
        context.extensionUri,
        () => ({
          root,
          session,
          contract,
          findings,
          changes,
          waivers
        }),
        async () => {
          await runCheck();
        },
        async () => {
          if (root) {
            await revertOutOfScopeFiles(root);
            await runCheck();
          }
        },
        async () => {
          await stopContract();
        }
      );
    }),
    vscode.commands.registerCommand("intentContract.visualizeArchitecture", async () => {
      if (!latestArchitectureAnalysis && root && session && contract?.architecture && contract.forbid.includes("architecture_drift")) {
        try {
          const activePolicyTree = policyTreeHash(session);
          const currentTreeHash = await createWorkingTreeSnapshot(root, contract.scope.read_only);
          const currentDiff = await diffTrees(root, activePolicyTree, currentTreeHash);
          latestArchitectureAnalysis = await analyzeArchitectureDrift(root, activePolicyTree, currentDiff, contract, session.activeContract);
        } catch {
          // Ignore
        }
      }
      return ArchitectureInspectorPanel.createOrShow(
        context.extensionUri,
        () => ({
          root,
          session,
          contract,
          analysis: latestArchitectureAnalysis,
          diagramPath: contract?.architecture?.diagram
        }),
        async () => {
          await runCheck();
        },
        async (file: string) => {
          if (root) {
            await revertIntentFile(root, file);
            await runCheck();
          }
        }
      );
    }),
    vscode.commands.registerCommand("intentContract.addSymbolToScope", async (symbolArg?: string) => {
      const repoRoot = root ?? await workspaceRepositoryRoot();
      if (!repoRoot) return;
      await addSymbolToScope(repoRoot, () => session, async () => {
        await reloadActiveContractAndSync(repoRoot);
      }, typeof symbolArg === "string" ? symbolArg : undefined);
    }),
    vscode.commands.registerCommand("intentContract.addFileToScope", async (uriArg?: vscode.Uri) => {
      const repoRoot = root ?? await workspaceRepositoryRoot();
      if (!repoRoot) return;
      await addFileToScope(repoRoot, () => session, async () => {
        await reloadActiveContractAndSync(repoRoot);
      }, uriArg instanceof vscode.Uri ? uriArg : undefined);
    }),
    vscode.commands.registerCommand("intentContract.markFileReadOnly", async (uriArg?: vscode.Uri) => {
      const repoRoot = root ?? await workspaceRepositoryRoot();
      if (!repoRoot) return;
      await markFileReadOnly(repoRoot, () => session, async () => {
        await reloadActiveContractAndSync(repoRoot);
      }, uriArg instanceof vscode.Uri ? uriArg : undefined);
    }),
    vscode.commands.registerCommand("intentContract.revertFile", async (value?: unknown) => revertFindingFile(unwrapFinding(value) ?? await chooseCurrentFinding(), actionContext)),
    vscode.commands.registerCommand("intentContract.waiveFinding", (value?: unknown) => waiveFinding(unwrapFinding(value), actionContext)),
    vscode.commands.registerCommand("intentContract.exportReport", async () => {
      if (!root || !session || !contract) {
        void vscode.window.showWarningMessage("Start an Intent Contract session before exporting a compliance report.");
        return;
      }
      try {
        const allWaivers = await readWaiversForContract(root, contract.allow_exceptions, true);
        const reportPath = await generateComplianceReport({
          root,
          session,
          contract,
          changes,
          findings,
          waivers: allWaivers
        });
        const uri = vscode.Uri.file(reportPath);
        try {
          await vscode.commands.executeCommand("markdown.showPreview", uri);
        } catch {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc);
        }
        void vscode.window.showInformationMessage(`Exported session compliance report to ${path.relative(root, reportPath)}.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Could not generate compliance report: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
    vscode.commands.registerCommand("intentContract.statusClick", async () => {
      const activeFindings = findings.filter((f) => !waivers.has(f.id));
      const items: Array<vscode.QuickPickItem & { action: () => Promise<void> | void }> = [];

      if (session && contract) {
        items.push({
          label: `$(shield) Intent: ${contract.name}`,
          description: activeFindings.length === 0 ? "✅ 100% Compliant (0 findings)" : `⚠️ ${activeFindings.length} active finding(s)`,
          detail: `Intent: "${contract.intent}"`,
          action: () => { void vscode.commands.executeCommand("intentContract.openDashboard"); }
        });
        items.push({
          label: "$(dashboard) Open Mission Control Dashboard",
          description: "Live scorecards, metrics, and corrective prompt generator",
          action: () => { void vscode.commands.executeCommand("intentContract.openDashboard"); }
        });
        if (contract.architecture) {
          items.push({
            label: "$(graph) View Architecture Drift Inspector",
            description: "Interactive visual diagram overlay with green/red boundary edges",
            action: () => { void vscode.commands.executeCommand("intentContract.visualizeArchitecture"); }
          });
        }
        items.push({
          label: "$(copy) Copy Corrective Prompt for AI Agent",
          description: "Format active findings for Cursor, Claude Code, Copilot, or Antigravity",
          action: () => { void copyFindingsForAgent(actionContext); }
        });
        items.push({
          label: "$(report) Export Session Compliance Report",
          description: "Generate verified AI safety report in .intent/reports/",
          action: () => { void vscode.commands.executeCommand("intentContract.exportReport"); }
        });
        items.push({
          label: "$(refresh) Re-check Workspace Now",
          description: "Manually trigger contract verification against baseline snapshot",
          action: () => { void runCheck(); }
        });
        items.push({
          label: "$(stop-circle) Stop Contract Session",
          description: "End active session and clear baseline snapshot",
          action: () => { void stopContract(); }
        });
      } else {
        items.push({
          label: "$(play) Start Contract Session...",
          description: "Choose and lock a contract from .intent/",
          action: () => { void startContract(); }
        });
        items.push({
          label: "$(symbol-event) Visual Contract Builder",
          description: "Create a task contract interactively without YAML",
          action: () => {
            if (extensionContext) {
              void VisualContractBuilderPanel.createOrShow(extensionContext.extensionUri, async (name) => {
                await startContractByName(name);
              });
            }
          }
        });
        items.push({
          label: "$(rocket) Getting Started Walkthrough",
          description: "Interactive 5-step onboarding guide",
          action: () => { void vscode.commands.executeCommand("intentContract.openWalkthrough"); }
        });
        items.push({
          label: "$(book) Open Vibe Coding Guide",
          description: "Best practices and prompt rules for autonomous agents",
          action: () => {
            if (extensionContext) void openVibeCodingGuide(extensionContext);
          }
        });
      }

      items.push({
        label: "$(layout-sidebar-left) Focus Intent Contract Sidebar",
        description: "Open the dedicated sidebar tree view",
        action: async () => {
          try {
            await vscode.commands.executeCommand("intentContractFindings.focus");
          } catch {
            await vscode.commands.executeCommand("workbench.view.extension.intent-contract-sidebar");
          }
        }
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: session ? `Intent Contract: ${contract?.name} (${activeFindings.length} findings)` : "Intent Contract (Inactive)"
      });

      if (selected) {
        await selected.action();
      }
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const scheduleCheck = (): void => {
    const config = vscode.workspace.getConfiguration("intentContract");
    if (config.get<boolean>("autoCheck", true) === false) return;
    const debounceMs = config.get<number>("debounce", 300);
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      checkTimer = undefined;
      void runCheck();
    }, debounceMs);
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

  const extensionVersion = (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? "0.3.0";
  const lastSeenVersion = context.globalState.get<string>("lastSeenGuideVersion");
  if (lastSeenVersion !== extensionVersion) {
    void context.globalState.update("lastSeenGuideVersion", extensionVersion);
    void vscode.window.showInformationMessage(
      `Welcome to Intent Contract v${extensionVersion}! Guard your workspace during vibe coding with autonomous agents.`,
      "Open Walkthrough",
      "Visual Contract Builder",
      "Open Guide"
    ).then(async (action) => {
      if (action === "Open Walkthrough") {
        await vscode.commands.executeCommand("workbench.action.openWalkthrough", "anilkumar4.intent-contract#intentContractWalkthrough", false);
      } else if (action === "Visual Contract Builder") {
        await VisualContractBuilderPanel.createOrShow(context.extensionUri, async (name) => {
          await startContractByName(name);
        });
      } else if (action === "Open Guide") {
        await openVibeCodingGuide(context);
      }
    });
  }
}

export function deactivate(): void {
  if (checkTimer) clearTimeout(checkTimer);
}

async function openVibeCodingGuide(context: vscode.ExtensionContext): Promise<void> {
  const guidePath = context.asAbsolutePath("docs/vibe-coding-guide.md");
  const uri = vscode.Uri.file(guidePath);
  try {
    await vscode.commands.executeCommand("markdown.showPreview", uri);
  } catch {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    } catch {
      void vscode.env.openExternal(vscode.Uri.parse("https://github.com/anilkumar4/intent-contract-vs-ext/blob/master/docs/vibe-coding-guide.md"));
    }
  }
}

async function startContract(): Promise<void> {
  const repoRoot = await workspaceRepositoryRoot();
  if (!repoRoot) return;
  if (await readSession(repoRoot)) {
    void vscode.window.showWarningMessage("A contract session is already active. Stop it before starting a replacement baseline.");
    return;
  }
  const files = await discoverContracts(repoRoot);
  if (files.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      "No contract YAML files were found in .intent/.",
      "Visual Contract Builder",
      "Create Contract From Template",
      "Open Vibe Coding Guide"
    );
    if (choice === "Visual Contract Builder" && extensionContext) {
      await VisualContractBuilderPanel.createOrShow(extensionContext.extensionUri, async (name) => {
        await startContractByName(name);
      });
    } else if (choice === "Create Contract From Template") {
      await createTemplate();
    } else if (choice === "Open Vibe Coding Guide" && extensionContext) {
      await openVibeCodingGuide(extensionContext);
    }
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

  root = repoRoot;
  contract = selectedContract;
  await ensureIntentMetadataIgnored(repoRoot);
  await syncActiveContractToAgents(repoRoot, selectedContract);
  const snapshot = await captureBaseline(repoRoot, selectedContract.scope.read_only);
  session = {
    ...snapshot,
    activeContract: toRepoPath(path.relative(repoRoot, selected)),
    originalBaselineTreeHash: snapshot.baselineTreeHash
  };
  contract = await loadContractFromBaseline(repoRoot, session);
  await writeSession(repoRoot, session);
  void vscode.window.showInformationMessage(`Started contract "${selectedContract.name}" from the current working tree.`);
  await runCheck();
  codeLensProvider?.refresh();
}

async function startContractByName(name: string): Promise<void> {
  const repoRoot = await workspaceRepositoryRoot();
  if (!repoRoot) return;
  if (await readSession(repoRoot)) {
    void vscode.window.showWarningMessage("A contract session is already active. Stop it before starting a replacement baseline.");
    return;
  }
  const files = await discoverContracts(repoRoot);
  const sanitized = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const matched = files.find((f) => {
    const base = path.basename(f, path.extname(f)).toLowerCase();
    return base === name.toLowerCase() || base === sanitized;
  });
  if (!matched) {
    void vscode.window.showErrorMessage(`Contract "${name}" was not found in .intent/.`);
    return;
  }

  let selectedContract: Contract;
  try {
    selectedContract = await loadContract(matched);
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error));
    return;
  }

  root = repoRoot;
  contract = selectedContract;
  await ensureIntentMetadataIgnored(repoRoot);
  await syncActiveContractToAgents(repoRoot, selectedContract);
  const snapshot = await captureBaseline(repoRoot, selectedContract.scope.read_only);
  session = {
    ...snapshot,
    activeContract: toRepoPath(path.relative(repoRoot, matched)),
    originalBaselineTreeHash: snapshot.baselineTreeHash
  };
  contract = await loadContractFromBaseline(repoRoot, session);
  await writeSession(repoRoot, session);
  void vscode.window.showInformationMessage(`Started contract "${selectedContract.name}" from the current working tree.`);
  await runCheck();
  codeLensProvider?.refresh();
}

async function reloadActiveContractAndSync(repoRoot: string): Promise<void> {
  const savedSession = await readSession(repoRoot);
  if (savedSession) {
    session = await ensurePolicyBaselineRef(repoRoot, savedSession);
    contract = await loadContractFromBaseline(repoRoot, session);
    await syncActiveContractToAgents(repoRoot, contract);
  }
  await runCheck();
  codeLensProvider?.refresh();
}

async function stopContract(): Promise<void> {
  if (!root || !session) {
    statusBar.update(undefined, []);
    return;
  }
  await releaseSessionBaselineRefs(root, session);
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
  latestArchitectureAnalysis = undefined;
  diagnostics.update(undefined, []);
  treeProvider.setState(false, [], waivers);
  statusBar.update(undefined, []);
  if (MissionControlDashboardPanel.currentPanel) void MissionControlDashboardPanel.currentPanel.refresh();
  if (ArchitectureInspectorPanel.currentPanel) void ArchitectureInspectorPanel.currentPanel.refresh();
  if (root) void clearActiveContractFromAgents(root);
  codeLensProvider?.refresh();
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
    { label: "GitHub Copilot", description: ".vscode/mcp.json + .github/copilot-instructions.md", picked: true, integration: "copilot" },
    { label: "Git Pre-Commit Hook", description: ".git/hooks/pre-commit (blocks commits on contract errors)", picked: true, integration: "precommit" },
    { label: "Git Pre-Push Hook", description: ".git/hooks/pre-push (blocks git push on contract errors)", picked: true, integration: "prepush" }
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
  if (checkRunning) {
    return new Promise<void>((resolve) => {
      queuedResolvers.push(resolve);
    });
  }
  checkRunning = true;
  try {
    while (checkQueued) {
      checkQueued = false;
      const currentResolvers = queuedResolvers;
      queuedResolvers = [];
      await performCheck();
      for (const resolve of currentResolvers) resolve();
    }
  } finally {
    checkRunning = false;
    const remaining = queuedResolvers;
    queuedResolvers = [];
    for (const resolve of remaining) resolve();
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
      latestArchitectureAnalysis = undefined;
      diagnostics.update(undefined, []);
      treeProvider?.setState(false, [], new Map());
      statusBar?.update(undefined, []);
      if (MissionControlDashboardPanel.currentPanel) void MissionControlDashboardPanel.currentPanel.refresh();
      if (ArchitectureInspectorPanel.currentPanel) void ArchitectureInspectorPanel.currentPanel.refresh();
      codeLensProvider?.refresh();
    }
    return;
  }
  const pinnedSession = (session && session.baselineTreeHash === savedSession.baselineTreeHash && session.originalBaselineRef === savedSession.originalBaselineRef)
    ? session
    : await ensurePolicyBaselineRef(root, savedSession);
  if (
    !session || !contract || policyTreeHash(session) !== policyTreeHash(pinnedSession) ||
    session.activeContract !== pinnedSession.activeContract
  ) {
    session = pinnedSession;
    contract = await loadContractFromBaseline(root, pinnedSession);
  } else {
    session = pinnedSession;
  }
  try {
    const activePolicyTree = policyTreeHash(session);
    const currentTreeHash = await createWorkingTreeSnapshot(root, contract.scope.read_only);
    const diff = await diffTrees(root, activePolicyTree, currentTreeHash);
    const nextFindings = await detectFindingsForWorkspace(root, activePolicyTree, diff, contract, session.activeContract);
    const config = vscode.workspace.getConfiguration("intentContract");
    const userIgnored = config.get<string[]>("ignoredPaths", []);
    const severityOverrides = config.get<Record<string, "error" | "warning">>("severityOverrides", {});
    let filteredFindings = nextFindings;
    if (userIgnored && userIgnored.length > 0) {
      filteredFindings = filteredFindings.filter((f) => {
        return !userIgnored.some((pattern) =>
          picomatch.isMatch(f.file.replace(/\\/g, "/"), pattern.replace(/\\/g, "/"), { dot: true })
        );
      });
    }
    if (severityOverrides && Object.keys(severityOverrides).length > 0) {
      for (const finding of filteredFindings) {
        const ruleOverride = finding.rule ? severityOverrides[finding.rule] : undefined;
        const override = ruleOverride ?? severityOverrides[finding.detector];
        if (override === "error" || override === "warning") {
          finding.severity = override;
        }
      }
    }
    const nextWaivers = await readWaiversForContract(root, contract.allow_exceptions);
    const active = filteredFindings.filter((finding) => !nextWaivers.has(finding.id));
    changes = diff.changes;
    findings = filteredFindings;
    waivers = nextWaivers;
    diagnostics.update(root, active);
    treeProvider.setState(true, filteredFindings, nextWaivers);
    statusBar.update(contract.name, active);
    await writeViolationSummary(root, filteredFindings, nextWaivers);

    if (contract.architecture && contract.forbid.includes("architecture_drift")) {
      try {
        latestArchitectureAnalysis = await analyzeArchitectureDrift(
          root,
          activePolicyTree,
          diff,
          contract,
          session.activeContract
        );
      } catch {
        latestArchitectureAnalysis = undefined;
      }
    } else {
      latestArchitectureAnalysis = undefined;
    }

    if (MissionControlDashboardPanel.currentPanel) void MissionControlDashboardPanel.currentPanel.refresh();
    if (ArchitectureInspectorPanel.currentPanel) void ArchitectureInspectorPanel.currentPanel.refresh();
    codeLensProvider?.refresh();

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
    const activePolicyTree = policyTreeHash(session);
    const currentTreeHash = await createWorkingTreeSnapshot(root, contract.scope.read_only);
    const currentDiff = await diffTrees(root, activePolicyTree, currentTreeHash);
    changes = currentDiff.changes;
    const analysis = await analyzeArchitectureDrift(
      root,
      activePolicyTree,
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
    const existingSession = await readSession(repoRoot);
    const savedSession = existingSession ? await ensurePolicyBaselineRef(repoRoot, existingSession) : undefined;
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
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    if (showError) void vscode.window.showErrorMessage("Open a Git repository folder before starting an Intent Contract.");
    return undefined;
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri && activeUri.scheme === "file") {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (activeFolder) {
      try {
        return await findRepositoryRoot(activeFolder.uri.fsPath);
      } catch {
        // Fall back to scanning folders
      }
    }
  }
  for (const folder of folders) {
    try {
      return await findRepositoryRoot(folder.uri.fsPath);
    } catch {
      continue;
    }
  }
  if (showError) void vscode.window.showErrorMessage("The current workspace is not inside a Git repository.");
  return undefined;
}

function isIgnored(uri: vscode.Uri): boolean {
  if (!root || uri.scheme !== "file") return true;
  const relative = path.relative(root, uri.fsPath).replace(/\\/g, "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return true;
  if (relative === ".intent/.violations.md" || relative === ".intent/.state.json" || relative.startsWith(".git/")) return true;
  const segments = relative.split("/");
  if (segments.some((part) => part === ".git" || part === "node_modules" || part === "dist" || part === "out" || part === "build")) {
    return true;
  }
  const config = vscode.workspace.getConfiguration("intentContract");
  const userIgnored = config.get<string[]>("ignoredPaths", []);
  if (userIgnored && userIgnored.length > 0) {
    if (userIgnored.some((pattern) => picomatch.isMatch(relative, pattern.replace(/\\/g, "/"), { dot: true }))) return true;
  }
  return false;
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
    "cat-file", "blob", `${policyTreeHash(savedSession)}:${savedSession.activeContract}`
  ]);
  return parseContract(buffer.toString("utf8"), path.basename(savedSession.activeContract));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
