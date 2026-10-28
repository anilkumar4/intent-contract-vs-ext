import * as vscode from "vscode";
import path from "node:path";
import type { Contract } from "../contract/schema";
import type { ContractSession } from "../state/session";
import type { ArchitectureAnalysis } from "../detectors/architectureDrift";
import { renderArchitectureDriftDiagram } from "../detectors/architectureDrift";
import { addPathPatternToScope } from "./scopeHelpers";

export interface ArchitectureInspectorContext {
  root: string | undefined;
  session: ContractSession | undefined;
  contract: Contract | undefined;
  analysis: ArchitectureAnalysis | undefined;
  diagramPath: string | undefined;
}

export class ArchitectureInspectorPanel {
  public static currentPanel: ArchitectureInspectorPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private getContext: () => ArchitectureInspectorContext;
  private onRecheck: () => Promise<void>;
  private onRevertFile: (file: string) => Promise<void>;

  public static async createOrShow(
    extensionUri: vscode.Uri,
    getContext: () => ArchitectureInspectorContext,
    onRecheck: () => Promise<void>,
    onRevertFile: (file: string) => Promise<void>
  ): Promise<ArchitectureInspectorPanel> {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

    if (ArchitectureInspectorPanel.currentPanel) {
      ArchitectureInspectorPanel.currentPanel.panel.reveal(column);
      await ArchitectureInspectorPanel.currentPanel.refresh();
      return ArchitectureInspectorPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "intentContractArchitectureInspector",
      "Intent Contract: Architecture Drift Inspector",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    ArchitectureInspectorPanel.currentPanel = new ArchitectureInspectorPanel(
      panel,
      getContext,
      onRecheck,
      onRevertFile
    );
    await ArchitectureInspectorPanel.currentPanel.refresh();
    return ArchitectureInspectorPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    getContext: () => ArchitectureInspectorContext,
    onRecheck: () => Promise<void>,
    onRevertFile: (file: string) => Promise<void>
  ) {
    this.panel = panel;
    this.getContext = getContext;
    this.onRecheck = onRecheck;
    this.onRevertFile = onRevertFile;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message: { command: string; file?: string; line?: number }) => {
        switch (message.command) {
          case "recheck":
            await this.onRecheck();
            await this.refresh();
            break;
          case "jumpToLine":
            if (message.file) {
              await this.jumpToLine(message.file, message.line ?? 1);
            }
            break;
          case "revertFile":
            if (message.file) {
              await this.onRevertFile(message.file);
              await this.refresh();
            }
            break;
          case "openContract": {
            const ctx = this.getContext();
            if (ctx.root && ctx.session?.activeContract) {
              const uri = vscode.Uri.file(path.join(ctx.root, ctx.session.activeContract));
              await vscode.commands.executeCommand("vscode.open", uri);
            }
            break;
          }
          case "openDiagram": {
            const ctx = this.getContext();
            if (ctx.root && ctx.diagramPath) {
              const uri = vscode.Uri.file(path.join(ctx.root, ctx.diagramPath));
              await vscode.commands.executeCommand("vscode.open", uri);
            }
            break;
          }
          case "exportDiagram":
            void vscode.commands.executeCommand("intentContract.exportArchitectureDrift");
            break;
          case "scopeNode": {
            const nodeMsg = message as { command: string; node?: string; mode?: "modify" | "read_only" };
            if (nodeMsg.node) {
              const ctx = this.getContext();
              if (ctx.root && ctx.contract) {
                const paths = ctx.contract.architecture?.node_mappings?.[nodeMsg.node] ?? [`src/${nodeMsg.node.toLowerCase()}/**`];
                for (const p of paths) {
                  await addPathPatternToScope(ctx.root, ctx.session, this.onRecheck, p, nodeMsg.mode ?? "modify");
                }
                await this.refresh();
                void vscode.window.showInformationMessage(
                  `Updated contract baseline: Node "${nodeMsg.node}" mapped to ${nodeMsg.mode === "modify" ? "modify scope" : "read-only"}.`
                );
              }
            }
            break;
          }
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
    ArchitectureInspectorPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const item = this.disposables.pop();
      if (item) item.dispose();
    }
  }

  private async jumpToLine(repoFile: string, line: number): Promise<void> {
    const ctx = this.getContext();
    if (!ctx.root) return;
    const absPath = path.join(ctx.root, repoFile);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
      const targetLine = Math.max(0, line - 1);
      const pos = new vscode.Position(targetLine, 0);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(pos, pos),
        viewColumn: vscode.ViewColumn.One
      });
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not open ${repoFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private renderHtml(ctx: ArchitectureInspectorContext): string {
    const hasSession = Boolean(ctx.session && ctx.contract);
    const hasArchConfig = Boolean(ctx.contract?.architecture?.diagram);
    const hasForbid = Boolean(ctx.contract?.forbid.includes("architecture_drift"));
    const analysis = ctx.analysis;
    const violations = analysis?.violations ?? [];
    const nodeCount = analysis?.graph.nodes.size ?? 0;
    const edgeCount = analysis?.graph.allowedEdges.size ?? 0;
    const violationCount = violations.length;

    let mermaidSrc = "";
    if (analysis && ctx.diagramPath && nodeCount > 0) {
      mermaidSrc = renderArchitectureDriftDiagram(analysis.graph, violations, ctx.diagramPath);
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Intent Contract: Architecture Drift Inspector</title>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
    mermaid.initialize({
      startOnLoad: true,
      theme: 'dark',
      flowchart: { curve: 'basis', htmlLabels: true }
    });
  </script>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-foreground, #cccccc);
      --card-bg: var(--vscode-editorWidget-background, #252526);
      --card-border: var(--vscode-widget-border, #3c3c3c);
      --accent: var(--vscode-button-background, #0e639c);
      --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
      --accent-fg: var(--vscode-button-foreground, #ffffff);
      --danger: var(--vscode-errorForeground, #f48771);
      --danger-bg: rgba(244, 135, 113, 0.12);
      --success: var(--vscode-testing-iconPassed, #89d185);
      --success-bg: rgba(137, 209, 133, 0.12);
      --badge-bg: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background-color: var(--bg);
      padding: 24px;
      line-height: 1.5;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
    }
    .header-left h1 {
      font-size: 20px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .header-left p {
      color: var(--vscode-descriptionForeground, #888888);
      font-size: 12px;
      margin-top: 4px;
    }
    .header-actions {
      display: flex;
      gap: 8px;
    }

    .btn {
      background-color: var(--card-bg);
      color: var(--fg);
      border: 1px solid var(--card-border);
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background 0.15s ease;
    }
    .btn:hover { background-color: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31)); }
    .btn-primary {
      background-color: var(--accent);
      color: var(--accent-fg);
      border-color: var(--accent);
    }
    .btn-primary:hover { background-color: var(--accent-hover); }
    .btn-danger {
      color: var(--danger);
      border-color: var(--danger);
    }
    .btn-danger:hover {
      background-color: var(--danger-bg);
    }

    .scorecards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 16px;
    }
    .card-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground, #888888);
      margin-bottom: 8px;
    }
    .card-value {
      font-size: 24px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .card-status-pass { color: var(--success); }
    .card-status-fail { color: var(--danger); }

    .panel-section {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .section-title {
      font-size: 15px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .diagram-container {
      background: var(--bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 20px;
      overflow-x: auto;
      text-align: center;
      min-height: 200px;
      display: flex;
      justify-content: center;
      align-items: center;
    }

    .legend {
      display: flex;
      gap: 16px;
      font-size: 12px;
      margin-top: 12px;
      justify-content: center;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .legend-dot {
      width: 12px;
      height: 12px;
      border-radius: 2px;
    }
    .dot-allowed { background: #4caf50; }
    .dot-violation { background: #e53935; border: 1px dashed #ffffff; }

    .violations-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
    }
    .violations-table th, .violations-table td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--card-border);
      font-size: 12px;
    }
    .violations-table th {
      background: rgba(255, 255, 255, 0.03);
      color: var(--vscode-descriptionForeground, #888888);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
    }
    .module-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      background: var(--badge-bg);
      color: var(--badge-fg);
      font-size: 11px;
      font-weight: 500;
    }
    .arrow-icon {
      color: var(--danger);
      font-weight: bold;
      margin: 0 4px;
    }

    .callout {
      padding: 16px;
      border-radius: 6px;
      background: var(--card-bg);
      border-left: 4px solid var(--accent);
      margin-bottom: 20px;
    }
    .callout-warning {
      border-left-color: var(--danger);
      background: var(--danger-bg);
    }
    .callout-success {
      border-left-color: var(--success);
      background: var(--success-bg);
    }

    pre.mermaid-fallback {
      text-align: left;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      background: rgba(0,0,0,0.2);
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>
        <span>🏛️</span> Intent Contract: Architecture Drift Inspector
      </h1>
      <p>
        ${ctx.contract ? `Contract: <strong>${escapeHtml(ctx.contract.name)}</strong> · Intent: "${escapeHtml(ctx.contract.intent)}"` : "No active contract session."}
        ${ctx.diagramPath ? ` · Policy Diagram: <code>${escapeHtml(ctx.diagramPath)}</code>` : ""}
      </p>
    </div>
    <div class="header-actions">
      <button class="btn" onclick="postCmd('openContract')">📄 Contract YAML</button>
      ${ctx.diagramPath ? `<button class="btn" onclick="postCmd('openDiagram')">📐 Baseline Diagram</button>` : ""}
      <button class="btn" onclick="postCmd('exportDiagram')">💾 Export .mmd</button>
      <button class="btn btn-primary" onclick="postCmd('recheck')">🔄 Re-check</button>
    </div>
  </div>

  ${!hasSession ? `
    <div class="callout callout-warning">
      <strong>No Contract Active:</strong> Start an Intent Contract first to monitor your codebase against architectural drift.
    </div>
  ` : !hasArchConfig ? `
    <div class="callout callout-warning">
      <strong>Architecture Drift Not Configured:</strong> The active contract does not declare an <code>architecture.diagram</code>.
      <p style="margin-top: 8px;">To enable architecture drift protection, add the following to your contract YAML:</p>
      <pre style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 4px; margin-top: 8px;">architecture:
  diagram: docs/architecture.mmd
  node_mappings:
    Domain:
      - "src/domain/**"
    Infrastructure:
      - "src/infra/**"
forbid:
  - architecture_drift</pre>
      <div style="margin-top: 12px;">
        <button class="btn btn-primary" onclick="postCmd('openContract')">Open Contract YAML to Configure</button>
      </div>
    </div>
  ` : !hasForbid ? `
    <div class="callout callout-warning">
      <strong>architecture_drift rule not in forbid:</strong> Your contract specifies a diagram, but <code>architecture_drift</code> is not in the <code>forbid</code> list.
      <div style="margin-top: 8px;">
        <button class="btn btn-primary" onclick="postCmd('openContract')">Enable in Contract YAML</button>
      </div>
    </div>
  ` : `
    <div class="scorecards">
      <div class="card">
        <div class="card-title">Architecture Health</div>
        <div class="card-value ${violationCount === 0 ? "card-status-pass" : "card-status-fail"}">
          ${violationCount === 0 ? "✅ Compliant" : `❌ ${violationCount} Drift(s)`}
        </div>
      </div>
      <div class="card">
        <div class="card-title">Diagram Nodes</div>
        <div class="card-value">${nodeCount}</div>
      </div>
      <div class="card">
        <div class="card-title">Allowed Paths</div>
        <div class="card-value">${edgeCount}</div>
      </div>
      <div class="card">
        <div class="card-title">Active Violations</div>
        <div class="card-value ${violationCount > 0 ? "card-status-fail" : ""}">${violationCount}</div>
      </div>
    </div>

    <div class="panel-section">
      <div class="section-header">
        <div class="section-title">
          <span>📐</span> Live Architectural Graph & Drift Overlay
        </div>
      </div>
      <div class="diagram-container">
        <pre class="mermaid">
${mermaidSrc}
        </pre>
      </div>
      <div class="legend">
        <div class="legend-item"><div class="legend-dot dot-allowed"></div> Allowed Architectural Boundary</div>
        <div class="legend-item"><div class="legend-dot dot-violation"></div> Detected Drift Violation (Forbidden Cross-Import)</div>
      </div>
    </div>

    <div class="panel-section">
      <div class="section-header">
        <div class="section-title">
          <span>⚠️</span> Detected Architectural Drift Violations (${violationCount})
        </div>
      </div>

      ${violationCount === 0 ? `
        <div class="callout callout-success" style="margin-bottom: 0;">
          <strong>Workspace Clean:</strong> No unauthorized cross-module dependencies detected. All source code imports strictly honor the architectural baseline.
        </div>
      ` : `
        <table class="violations-table">
          <thead>
            <tr>
              <th>Boundary Breach</th>
              <th>Source File & Line</th>
              <th>Forbidden Target Import</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${violations.map((v) => `
              <tr>
                <td>
                  <span class="module-badge">${escapeHtml(v.sourceNode)}</span>
                  <span class="arrow-icon">🚫 ➔</span>
                  <span class="module-badge">${escapeHtml(v.targetNode)}</span>
                </td>
                <td>
                  <code>${escapeHtml(v.sourceFile)}:${v.line}</code>
                </td>
                <td>
                  <code>${escapeHtml(v.targetFile)}</code>
                </td>
                <td>
                  <div style="display: flex; gap: 6px;">
                    <button class="btn" onclick="jumpTo('${escapeAttr(v.sourceFile)}', ${v.line})">📍 Jump to Line</button>
                    <button class="btn btn-danger" onclick="revertFile('${escapeAttr(v.sourceFile)}')">⏪ Revert</button>
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `}
    </div>

    ${analysis && analysis.graph.nodes.size > 0 ? `
      <div class="panel-section">
        <div class="section-header">
          <div class="section-title">
            <span>📐</span> Architecture Nodes & Dynamic Scope Controls (${nodeCount})
          </div>
        </div>
        <table class="violations-table">
          <thead>
            <tr>
              <th>Architecture Node</th>
              <th>Mapped File Globs</th>
              <th>Dynamic Scope Action</th>
            </tr>
          </thead>
          <tbody>
            ${Array.from(analysis.graph.nodes.values()).map((node) => {
              const mapped = ctx.contract?.architecture?.node_mappings?.[node.id] ?? node.globs;
              const displayPaths = mapped && mapped.length > 0 ? mapped.join(", ") : `src/${node.id.toLowerCase()}/**`;
              return `
                <tr>
                  <td><span class="module-badge">${escapeHtml(node.label || node.id)}</span></td>
                  <td><code>${escapeHtml(displayPaths)}</code></td>
                  <td>
                    <div style="display: flex; gap: 6px;">
                      <button class="btn btn-primary" onclick="scopeNode('${escapeAttr(node.id)}', 'modify')">+ Add to Scope</button>
                      <button class="btn" onclick="scopeNode('${escapeAttr(node.id)}', 'read_only')">🔒 Lock Read-Only</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    ` : ""}
  `}

  <script>
    const vscode = acquireVsCodeApi();
    function postCmd(cmd) {
      vscode.postMessage({ command: cmd });
    }
    function jumpTo(file, line) {
      vscode.postMessage({ command: 'jumpToLine', file: file, line: line });
    }
    function revertFile(file) {
      vscode.postMessage({ command: 'revertFile', file: file });
    }
    function scopeNode(node, mode) {
      vscode.postMessage({ command: 'scopeNode', node: node, mode: mode });
    }
  </script>
</body>
</html>`;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(str: string): string {
  return str.replace(/"/g, "&quot;").replace(/'/g, "\\'");
}
