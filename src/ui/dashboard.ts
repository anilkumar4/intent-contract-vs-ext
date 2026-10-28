import * as vscode from "vscode";
import type { Finding, FileChange } from "../detectors/types";
import type { Contract } from "../contract/schema";
import type { ContractSession } from "../state/session";
import type { Waiver } from "../state/waivers";

export interface DashboardContext {
  root: string | undefined;
  session: ContractSession | undefined;
  contract: Contract | undefined;
  findings: Finding[];
  changes: FileChange[];
  waivers: Map<string, Waiver>;
}

export class MissionControlDashboardPanel {
  public static currentPanel: MissionControlDashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private getContext: () => DashboardContext;
  private onRecheck: () => Promise<void>;
  private onRevertOutOfScope: () => Promise<void>;
  private onStopContract: () => Promise<void>;

  public static async createOrShow(
    extensionUri: vscode.Uri,
    getContext: () => DashboardContext,
    onRecheck: () => Promise<void>,
    onRevertOutOfScope: () => Promise<void>,
    onStopContract: () => Promise<void>
  ): Promise<MissionControlDashboardPanel> {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

    if (MissionControlDashboardPanel.currentPanel) {
      MissionControlDashboardPanel.currentPanel.panel.reveal(column);
      await MissionControlDashboardPanel.currentPanel.refresh();
      return MissionControlDashboardPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "intentContractDashboard",
      "Intent Contract: Mission Control",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    MissionControlDashboardPanel.currentPanel = new MissionControlDashboardPanel(
      panel,
      getContext,
      onRecheck,
      onRevertOutOfScope,
      onStopContract
    );
    await MissionControlDashboardPanel.currentPanel.refresh();
    return MissionControlDashboardPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    getContext: () => DashboardContext,
    onRecheck: () => Promise<void>,
    onRevertOutOfScope: () => Promise<void>,
    onStopContract: () => Promise<void>
  ) {
    this.panel = panel;
    this.getContext = getContext;
    this.onRecheck = onRecheck;
    this.onRevertOutOfScope = onRevertOutOfScope;
    this.onStopContract = onStopContract;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message: { command: string }) => {
        switch (message.command) {
          case "recheck":
            await this.onRecheck();
            await this.refresh();
            break;
          case "revertOutOfScope":
            await this.onRevertOutOfScope();
            await this.refresh();
            break;
          case "stopContract":
            await this.onStopContract();
            await this.refresh();
            break;
          case "copyAgentPrompt":
            await this.copyCorrectivePrompt();
            break;
          case "openVisualBuilder":
            void vscode.commands.executeCommand("intentContract.visualBuilder");
            break;
          case "openGuide":
            void vscode.commands.executeCommand("intentContract.openGuide");
            break;
          case "openWalkthrough":
            void vscode.commands.executeCommand("intentContract.openWalkthrough");
            break;
          case "exportReport":
            void vscode.commands.executeCommand("intentContract.exportReport");
            break;
          case "configureAgents":
            void vscode.commands.executeCommand("intentContract.configureAgents");
            break;
        }
      },
      null,
      this.disposables
    );
  }

  public async refresh(): Promise<void> {
    const ctx = this.getContext();
    this.panel.webview.html = this.renderHtml(ctx);
  }

  public dispose(): void {
    MissionControlDashboardPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const item = this.disposables.pop();
      if (item) item.dispose();
    }
  }

  private async copyCorrectivePrompt(): Promise<void> {
    const ctx = this.getContext();
    if (!ctx.session || !ctx.contract) {
      void vscode.window.showWarningMessage("No active contract session.");
      return;
    }
    const activeFindings = ctx.findings.filter((f) => !ctx.waivers.has(f.id));
    if (activeFindings.length === 0) {
      void vscode.window.showInformationMessage("Workspace is 100% compliant! No corrective prompt needed.");
      return;
    }

    const lines = [
      `CORRECTIVE INSTRUCTIONS FOR AI AGENT:`,
      `The task "${ctx.contract.intent}" produced ${activeFindings.length} Intent Contract violation(s) that must be fixed:`,
      ""
    ];

    for (const finding of activeFindings) {
      lines.push(`- [${finding.severity.toUpperCase()}] ${finding.file}${finding.line ? `:${finding.line}` : ""}`);
      lines.push(`  Rule: [${finding.detector}/${finding.rule}] ${finding.message}`);
      if (finding.remediation) {
        lines.push(`  Remediation: ${finding.remediation}`);
      }
    }

    lines.push(
      "",
      "Contract Constraints:",
      `- Allowed modify paths: ${ctx.contract.scope.modify.join(", ")}`,
      `- Read-only protected paths: ${ctx.contract.scope.read_only.join(", ") || "none"}`,
      `- Allowed symbols: ${ctx.contract.scope.modify_symbols?.join(", ") || "all within modify paths"}`,
      "",
      "Please adjust your changes to resolve these violations immediately."
    );

    const text = lines.join("\n");
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage("Corrective prompt copied to clipboard! Paste it into your AI assistant.");
  }

  private renderHtml(ctx: DashboardContext): string {
    const isActive = Boolean(ctx.session && ctx.contract);
    const activeFindings = ctx.findings.filter((f) => !ctx.waivers.has(f.id));
    const errorCount = activeFindings.filter((f) => f.severity === "error").length;
    const warningCount = activeFindings.filter((f) => f.severity === "warning").length;

    const scopeFindings = activeFindings.filter((f) => f.detector === "scope" || f.detector === "symbol_scope");
    const testFindings = activeFindings.filter((f) => f.detector === "test_weakening" || f.detector === "tautological_tests");
    const depFindings = activeFindings.filter((f) => f.detector === "dependencies");
    const archFindings = activeFindings.filter((f) => f.detector === "architecture_drift");

    const statusBadge = isActive
      ? (errorCount === 0 && warningCount === 0
          ? `<span class="badge badge-success">● Compliant (0 violations)</span>`
          : `<span class="badge badge-danger">● ${errorCount} error(s), ${warningCount} warning(s)</span>`)
      : `<span class="badge badge-muted">● No Active Contract</span>`;

    const startedTime = ctx.session?.startedAt
      ? new Date(ctx.session.startedAt).toLocaleTimeString()
      : "N/A";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Intent Contract: Mission Control</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --card-bg: var(--vscode-editorWidget-background, #252526);
      --border: var(--vscode-editorWidget-border, #3c3c3c);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --btn-sec-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --btn-sec-fg: var(--vscode-button-secondaryForeground, #ffffff);
      --success: #4caf50;
      --danger: #f44336;
      --warning: #ff9800;
    }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto);
      background-color: var(--bg);
      color: var(--fg);
      margin: 0;
      padding: 24px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    .title-area h1 {
      margin: 0 0 6px 0;
      font-size: 22px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .title-area p {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .badge-success { background: rgba(76, 175, 80, 0.2); color: var(--success); border: 1px solid var(--success); }
    .badge-danger { background: rgba(244, 67, 54, 0.2); color: var(--danger); border: 1px solid var(--danger); }
    .badge-muted { background: var(--card-bg); color: var(--vscode-descriptionForeground); border: 1px solid var(--border); }

    .grid-scorecards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.15);
    }
    .card-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    .card-value {
      font-size: 20px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .card-hint {
      font-size: 11px;
      margin-top: 6px;
      color: var(--vscode-descriptionForeground);
    }

    .section-title {
      font-size: 15px;
      font-weight: 600;
      margin: 24px 0 12px 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 24px;
    }
    .btn {
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 500;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: opacity 0.15s;
    }
    .btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
    .btn-primary:hover { background: var(--btn-hover); }
    .btn-secondary { background: var(--btn-sec-bg); color: var(--btn-sec-fg); }
    .btn-secondary:hover { opacity: 0.85; }
    .btn-danger { background: rgba(244, 67, 54, 0.25); color: #ff6b6b; border: 1px solid var(--danger); }
    .btn-danger:hover { background: rgba(244, 67, 54, 0.4); }

    .findings-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      margin-top: 8px;
    }
    .findings-table th, .findings-table td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    .findings-table th {
      background: rgba(255,255,255,0.03);
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    .file-path {
      font-family: var(--vscode-editor-font-family, monospace);
      font-weight: 500;
    }
    .empty-state {
      padding: 32px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      background: var(--card-bg);
      border: 1px dashed var(--border);
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title-area">
      <h1>🛡️ Intent Contract Mission Control</h1>
      <p>${isActive ? `Active: <strong>${escapeHtml(ctx.contract!.name)}</strong> — "${escapeHtml(ctx.contract!.intent)}" · Started at ${startedTime}` : "No contract active. Start or build a contract to begin."}</p>
    </div>
    <div>${statusBadge}</div>
  </div>

  <div class="toolbar">
    <button class="btn btn-primary" onclick="sendMessage('recheck')">🔄 Re-check Now</button>
    ${isActive ? `<button class="btn btn-secondary" onclick="sendMessage('copyAgentPrompt')">📋 Copy Prompt for Agent</button>` : ""}
    ${isActive ? `<button class="btn btn-secondary" onclick="sendMessage('exportReport')">📑 Export Compliance Report</button>` : ""}
    ${isActive && activeFindings.length > 0 ? `<button class="btn btn-secondary" onclick="sendMessage('revertOutOfScope')">⚡ Revert Out-of-Scope Files</button>` : ""}
    ${isActive ? `<button class="btn btn-danger" onclick="sendMessage('stopContract')">⏹ Stop Session</button>` : `<button class="btn btn-primary" onclick="sendMessage('openVisualBuilder')">⚡ Open Visual Contract Builder</button>`}
    <button class="btn btn-secondary" onclick="sendMessage('configureAgents')">🤖 Configure Agents & Hooks</button>
    <button class="btn btn-secondary" onclick="sendMessage('openWalkthrough')">🚀 Getting Started Walkthrough</button>
    <button class="btn btn-secondary" onclick="sendMessage('openGuide')">📖 Vibe Coding Guide</button>
  </div>

  <div class="grid-scorecards">
    <div class="card">
      <div class="card-title">Scope Adherence</div>
      <div class="card-value" style="color: ${scopeFindings.length === 0 ? "var(--success)" : "var(--danger)"};">
        ${scopeFindings.length === 0 ? "✅ 100%" : `⚠️ ${scopeFindings.length} Drift`}
      </div>
      <div class="card-hint">${isActive ? `${ctx.changes.length} modified file(s) evaluated` : "Session inactive"}</div>
    </div>

    <div class="card">
      <div class="card-title">Test Fidelity</div>
      <div class="card-value" style="color: ${testFindings.length === 0 ? "var(--success)" : "var(--danger)"};">
        ${testFindings.length === 0 ? "🛡️ Solid" : `⚠️ ${testFindings.length} Weakened`}
      </div>
      <div class="card-hint">${escapeHtml(formatTestFidelityHint(testFindings))}</div>
    </div>

    <div class="card">
      <div class="card-title">Dependencies</div>
      <div class="card-value" style="color: ${depFindings.length === 0 ? "var(--success)" : "var(--danger)"};">
        ${depFindings.length === 0 ? "✅ Clean" : `⚠️ ${depFindings.length} Unapproved`}
      </div>
      <div class="card-hint">${depFindings.length === 0 ? "Lockfiles & manifests intact" : "New packages added"}</div>
    </div>

    <div class="card">
      <div class="card-title">Architecture</div>
      <div class="card-value" style="color: ${archFindings.length === 0 ? "var(--success)" : "var(--danger)"};">
        ${archFindings.length === 0 ? "✅ 0 Drift" : `⚠️ ${archFindings.length} Violations`}
      </div>
      <div class="card-hint">${ctx.contract?.architecture ? ctx.contract.architecture.diagram : "Diagram policy disabled"}</div>
    </div>
  </div>

  <div class="section-title">Active Violations (${activeFindings.length})</div>
  ${activeFindings.length > 0 ? `
    <table class="findings-table">
      <thead>
        <tr>
          <th>Severity</th>
          <th>File</th>
          <th>Detector</th>
          <th>Message</th>
          <th>Remediation</th>
        </tr>
      </thead>
      <tbody>
        ${activeFindings.map((f) => `
          <tr>
            <td><span class="badge ${f.severity === "error" ? "badge-danger" : "badge-muted"}">${escapeHtml(f.severity.toUpperCase())}</span></td>
            <td class="file-path">${escapeHtml(f.file)}${f.line ? `:${f.line}` : ""}</td>
            <td>${escapeHtml(f.detector)}</td>
            <td>${escapeHtml(f.message)}</td>
            <td>${f.remediation ? escapeHtml(f.remediation) : "Review contract scope rules"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  ` : `
    <div class="empty-state">
      ${isActive ? "🎉 All changes are fully compliant with the active Intent Contract!" : "Start an Intent Contract session to monitor your workspace in real-time."}
    </div>
  `}

  <script>
    const vscode = acquireVsCodeApi();
    function sendMessage(command) {
      vscode.postMessage({ command });
    }
  </script>
</body>
</html>`;
  }
}

export function formatTestFidelityHint(findings: Finding[]): string {
  if (findings.length === 0) {
    return "No assertion losses or downgrades";
  }
  const rules = new Set(findings.map((f) => f.rule));
  const categories: string[] = [];

  const hasWeakenedMatchers = rules.has("matcher_downgrade") || rules.has("assertion_negation_flip");
  const hasDeletedAssertions = rules.has("net_assertion_loss");
  const hasSkippedTests = rules.has("test_skipped") || rules.has("disabled_test") || rules.has("test_runner_exclusion");
  const hasDeletedTests = rules.has("net_test_block_loss") || rules.has("deleted_test_file");
  const hasWidenedTolerances = rules.has("numeric_tolerance_widened");
  const hasTrivialOrEmpty = rules.has("trivial_assertion") || rules.has("empty_test_block");
  const hasModifiedSnapshots = rules.has("snapshot_deleted") || rules.has("snapshot_modified") || rules.has("inline_snapshot_changed");

  if (hasWeakenedMatchers) categories.push("weakened matchers");
  if (hasDeletedAssertions) categories.push("deleted assertions");
  if (hasSkippedTests) categories.push("skipped tests");
  if (hasDeletedTests) categories.push("deleted test blocks");
  if (hasWidenedTolerances) categories.push("widened tolerances");
  if (hasTrivialOrEmpty) categories.push("trivial/empty tests");
  if (hasModifiedSnapshots) categories.push("modified snapshots");

  if (categories.length > 0) {
    const primary = categories.slice(0, 2).join(", ");
    return `Detected ${primary}${categories.length > 2 ? ", etc." : ""}`;
  }

  return "Weakened assertions or skipped tests";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
