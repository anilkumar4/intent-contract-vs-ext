import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs/promises";
import YAML from "yaml";
import { findRepositoryRoot } from "../git/cli";
import { ensureIntentMetadataIgnored } from "../contract/template";
import { contractSchema, type Contract } from "../contract/schema";
import { parseArchitectureDiagram } from "../architecture/diagramParser";

export interface DiscoveredDiagramNode {
  id: string;
  label: string;
  paths: string[];
}

export interface DiscoveredDiagram {
  path: string;
  nodes: DiscoveredDiagramNode[];
}

export class VisualContractBuilderPanel {
  public static currentPanel: VisualContractBuilderPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private onStartContract?: (name: string) => Promise<void>;
  private initialEditorText?: string;

  public static async createOrShow(
    extensionUri: vscode.Uri,
    onStartContract?: (name: string) => Promise<void>
  ): Promise<VisualContractBuilderPanel> {
    const activeEditor = vscode.window.activeTextEditor;
    const initialEditorText = activeEditor?.document.getText();
    const column = activeEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

    if (VisualContractBuilderPanel.currentPanel) {
      VisualContractBuilderPanel.currentPanel.panel.reveal(column);
      return VisualContractBuilderPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "intentContractVisualBuilder",
      "Intent Contract: Visual Builder",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    VisualContractBuilderPanel.currentPanel = new VisualContractBuilderPanel(panel, onStartContract, initialEditorText);
    await VisualContractBuilderPanel.currentPanel.update();
    return VisualContractBuilderPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    onStartContract?: (name: string) => Promise<void>,
    initialEditorText?: string
  ) {
    this.panel = panel;
    this.onStartContract = onStartContract;
    this.initialEditorText = initialEditorText;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message: { command: string; payload?: unknown }) => {
        switch (message.command) {
          case "saveAndStart":
            await this.handleSaveAndStart(message.payload);
            break;
          case "saveOnly":
            await this.handleSaveOnly(message.payload);
            break;
          case "copyPrompt":
            await this.handleCopyPrompt(message.payload);
            break;
          case "refreshContext":
            await this.update();
            break;
        }
      },
      null,
      this.disposables
    );
  }

  public dispose(): void {
    VisualContractBuilderPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) disposable.dispose();
    }
  }

  private async update(): Promise<void> {
    const root = await this.resolveRoot();
    const diagrams = root ? await this.discoverDiagrams(root) : [];
    const activeSymbols = this.extractActiveSymbols();
    const detectedFolders = root ? await this.discoverFolders(root) : ["src/**", "test/**"];

    this.panel.webview.html = this.renderHtml({
      diagrams,
      activeSymbols,
      detectedFolders
    });
  }

  private async resolveRoot(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    return await findRepositoryRoot(folders[0].uri.fsPath);
  }

  private async discoverDiagrams(root: string): Promise<DiscoveredDiagram[]> {
    const results: DiscoveredDiagram[] = [];
    const searchDirs = ["docs", "architecture", ".intent", "."];
    for (const subDir of searchDirs) {
      try {
        const dirPath = path.join(root, subDir);
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && (entry.name.endsWith(".mmd") || entry.name.endsWith(".drawio") || entry.name.endsWith(".dio"))) {
            const relPath = path.relative(root, path.join(dirPath, entry.name)).replace(/\\/g, "/");
            const nodes: DiscoveredDiagramNode[] = [];
            try {
              const content = await fs.readFile(path.join(dirPath, entry.name), "utf8");
              const graph = parseArchitectureDiagram(relPath, content);
              for (const [id, node] of graph.nodes) {
                const inferred = node.globs && node.globs.length > 0 ? node.globs : [`src/${id.toLowerCase()}/**`];
                nodes.push({ id, label: node.label || id, paths: inferred });
              }
            } catch {
              // ignore parse errors
            }
            results.push({ path: relPath, nodes });
          }
        }
      } catch {
        // ignore missing directory
      }
    }
    return results;
  }

  private async discoverFolders(root: string): Promise<string[]> {
    const presets = ["src/**", "test/**", "app/**", "lib/**", "packages/**"];
    const found: string[] = [];
    for (const preset of presets) {
      const base = preset.replace("/**", "");
      try {
        const stat = await fs.stat(path.join(root, base));
        if (stat.isDirectory()) found.push(preset);
      } catch {
        // ignore
      }
    }
    return found.length > 0 ? found : ["src/**", "test/**"];
  }

  private extractActiveSymbols(): string[] {
    const text = this.initialEditorText ?? vscode.window.activeTextEditor?.document.getText();
    if (!text) return [];
    const symbols = new Set<string>();

    const fnPattern = /(?:function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)|const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)|(?:public|private|protected|async|\s)*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*[{:])/g;
    let match: RegExpExecArray | null;
    while ((match = fnPattern.exec(text)) !== null) {
      const name = match[1] || match[2] || match[3] || match[4];
      if (name && !["if", "for", "while", "switch", "catch", "constructor"].includes(name)) {
        symbols.add(name);
      }
    }
    return [...symbols].slice(0, 15);
  }

  private async handleSaveAndStart(payload: unknown): Promise<void> {
    const contract = this.validatePayload(payload);
    if (!contract) return;

    const root = await this.resolveRoot();
    if (!root) {
      void vscode.window.showErrorMessage("No Git repository root found for active workspace.");
      return;
    }

    const filePath = await this.saveContract(root, contract);
    if (!filePath) return;

    void vscode.window.showInformationMessage(`Saved contract "${contract.name}". Starting session...`);
    if (this.onStartContract) {
      const sanitizedName = path.basename(filePath, path.extname(filePath));
      await this.onStartContract(sanitizedName);
    }
    this.panel.dispose();
  }

  private async handleSaveOnly(payload: unknown): Promise<void> {
    const contract = this.validatePayload(payload);
    if (!contract) return;

    const root = await this.resolveRoot();
    if (!root) {
      void vscode.window.showErrorMessage("No Git repository root found for active workspace.");
      return;
    }

    const filePath = await this.saveContract(root, contract);
    if (!filePath) return;

    void vscode.window.showInformationMessage(`Saved contract template to .intent/${contract.name}.yaml`);
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);
  }

  private async handleCopyPrompt(payload: unknown): Promise<void> {
    const contract = this.validatePayload(payload);
    if (!contract) return;

    const prompt = this.generateAgentPrompt(contract);
    await vscode.env.clipboard.writeText(prompt);
    void vscode.window.showInformationMessage("AI Task Prompt copied to clipboard! Paste it into Cursor, Claude Code, Copilot, or Antigravity.");
  }

  private validatePayload(payload: unknown): Contract | undefined {
    if (!payload || typeof payload !== "object") {
      void vscode.window.showErrorMessage("Invalid contract data provided.");
      return undefined;
    }

    try {
      return contractSchema.parse(payload);
    } catch (error) {
      void vscode.window.showErrorMessage(`Validation failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private async saveContract(root: string, contract: Contract): Promise<string | undefined> {
    const intentDir = path.join(root, ".intent");
    await fs.mkdir(intentDir, { recursive: true });
    await ensureIntentMetadataIgnored(root);

    const fileName = `${contract.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}.yaml`;
    const filePath = path.join(intentDir, fileName);

    try {
      await fs.access(filePath);
      const answer = await vscode.window.showWarningMessage(
        `Contract template "${fileName}" already exists in .intent/. Do you want to overwrite it?`,
        { modal: true },
        "Overwrite",
        "Cancel"
      );
      if (answer !== "Overwrite") {
        return undefined;
      }
    } catch {
      // File does not exist, proceed
    }

    const yamlStr = YAML.stringify(contract, { indent: 2 });
    await fs.writeFile(filePath, yamlStr, "utf8");
    return filePath;
  }

  private generateAgentPrompt(contract: Contract): string {
    const lines = [
      `TASK INTENT: ${contract.intent}`,
      "",
      "GUARDRAIL CONTRACT (Intent Contract enforced):",
      `- Allowed modification paths: ${contract.scope.modify.join(", ")}`
    ];

    if (contract.scope.read_only.length > 0) {
      lines.push(`- Protected read-only paths (DO NOT MODIFY): ${contract.scope.read_only.join(", ")}`);
    }

    if (contract.scope.modify_symbols && contract.scope.modify_symbols.length > 0) {
      lines.push(`- Allowed functions/symbols: ${contract.scope.modify_symbols.join(", ")} (Edits outside these symbols will be rejected)`);
    }

    if (contract.forbid.length > 0) {
      lines.push("- Forbidden actions:");
      if (contract.forbid.includes("test_weakening")) {
        lines.push("  * NO TEST WEAKENING: Do not delete assertions, downgrade matchers, skip tests, or make tautological tests.");
      }
      if (contract.forbid.includes("new_dependencies")) {
        lines.push("  * NO NEW DEPENDENCIES: Do not add or upgrade packages in package.json or other manifests.");
      }
      if (contract.forbid.includes("high_risk_files")) {
        lines.push("  * NO HIGH-RISK EDITS: Do not touch CI workflows, Dockerfiles, or secrets.");
      }
      if (contract.forbid.includes("architecture_drift")) {
        lines.push(`  * ARCHITECTURE BOUNDARIES: Must strictly conform to ${contract.architecture?.diagram ?? "architecture diagram"}.`);
      }
    }

    lines.push("", "Please implement the requested changes while strictly respecting these boundaries.");
    return lines.join("\n");
  }

  private renderHtml(context: { diagrams: DiscoveredDiagram[]; activeSymbols: string[]; detectedFolders: string[] }): string {
    const symbolBadges = context.activeSymbols.map(
      (s) => `<button type="button" class="badge-btn" onclick="addSymbol('${escapeHtml(s)}')">+ ${escapeHtml(s)}</button>`
    ).join(" ");

    const folderBadges = context.detectedFolders.map(
      (f) => `<button type="button" class="badge-btn" onclick="addModifyPath('${escapeHtml(f)}')">+ ${escapeHtml(f)}</button>`
    ).join(" ");

    const diagramOptions = [
      `<option value="">None (skip architecture drift)</option>`,
      ...context.diagrams.map((d) => `<option value="${escapeHtml(d.path)}">${escapeHtml(d.path)} (${d.nodes.length} nodes)</option>`)
    ].join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Intent Contract: Visual Builder</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border, #3c3c3c);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --btn-sec-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --btn-sec-fg: var(--vscode-button-secondaryForeground, #ffffff);
      --card-bg: var(--vscode-editorWidget-background, #252526);
      --border: var(--vscode-editorWidget-border, #454545);
      --accent: var(--vscode-textLink-foreground, #3794ff);
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
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
    }
    .header h1 {
      margin: 0 0 8px 0;
      font-size: 20px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .header p {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 6px;
    }
    .hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    input[type="text"], textarea, select {
      width: 100%;
      box-sizing: border-box;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      padding: 8px 10px;
      border-radius: 4px;
      font-family: inherit;
      font-size: 13px;
    }
    textarea {
      min-height: 64px;
      resize: vertical;
    }
    .badge-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    .badge-btn {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 3px 8px;
      border-radius: 12px;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .badge-btn:hover {
      background: var(--input-border);
    }
    .checkbox-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
      background: var(--card-bg);
      padding: 14px;
      border-radius: 6px;
      border: 1px solid var(--border);
    }
    .checkbox-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    .checkbox-item input {
      margin-top: 3px;
    }
    .checkbox-label {
      font-size: 12px;
    }
    .checkbox-label strong {
      display: block;
      font-size: 12px;
      margin-bottom: 2px;
    }
    .checkbox-label span {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .actions-bar {
      margin-top: 28px;
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .btn {
      padding: 9px 18px;
      font-size: 13px;
      font-weight: 500;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .btn-primary {
      background: var(--btn-bg);
      color: var(--btn-fg);
    }
    .btn-primary:hover {
      background: var(--btn-hover);
    }
    .btn-secondary {
      background: var(--btn-sec-bg);
      color: var(--btn-sec-fg);
    }
    .btn-secondary:hover {
      opacity: 0.9;
    }
    .node-cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 10px;
      margin-top: 8px;
    }
    .node-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .node-card-title {
      font-weight: 600;
      font-size: 12px;
      color: var(--accent);
    }
    .node-card-paths {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-family: monospace;
      word-break: break-all;
    }
    .node-card-actions {
      display: flex;
      gap: 6px;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🛡️ Visual Contract Builder</h1>
    <p>Declare your AI task boundary visually. Generate contracts without writing YAML syntax.</p>
  </div>

  <form id="contractForm">
    <div class="form-group">
      <label for="name">Contract Name *</label>
      <div class="hint">Unique name identifying this feature or task (e.g. feature-proration, fix-auth-flow).</div>
      <input type="text" id="name" placeholder="feature-proration" required />
    </div>

    <div class="form-group">
      <label for="intent">Task Intent *</label>
      <div class="hint">Clear natural language goal describing what you are asking your AI agent to build.</div>
      <textarea id="intent" placeholder="Implement subscription proration calculations for billing upgrades" required></textarea>
    </div>

    <div class="form-group">
      <label for="modify">Allowed Modify Paths (scope.modify) *</label>
      <div class="hint">One glob pattern per line. Files outside these paths will produce errors if edited.</div>
      <textarea id="modify" placeholder="src/**&#10;test/**" required>src/**&#10;test/**</textarea>
      ${folderBadges ? `<div class="badge-bar"><span>Presets:</span> ${folderBadges}</div>` : ""}
    </div>

    <div class="form-group">
      <label for="readOnly">Protected Read-Only Paths (scope.read_only)</label>
      <div class="hint">One glob pattern per line. Explicitly protected files (e.g. database layers, secrets, configs).</div>
      <textarea id="readOnly" placeholder="secrets/**&#10;.env*&#10;src/shared/db.ts"></textarea>
    </div>

    <div class="form-group">
      <label for="symbols">Allowed Functions / Symbols (scope.modify_symbols)</label>
      <div class="hint">Comma-separated function or method names. Edits to local variables inside these functions are permitted; other symbol changes fail.</div>
      <input type="text" id="symbols" placeholder="prorate, calculateUpgradeDelta" />
      ${symbolBadges ? `<div class="badge-bar"><span>Active file symbols:</span> ${symbolBadges}</div>` : ""}
    </div>

    <div class="form-group">
      <label>Protection Guardrails (forbid)</label>
      <div class="hint">Select critical failure modes to guard against during AI vibe coding:</div>
      <div class="checkbox-grid">
        <div class="checkbox-item">
          <input type="checkbox" id="forbidTestWeakening" checked />
          <div class="checkbox-label">
            <strong>Forbid Test Weakening</strong>
            <span>Catches net assertion loss, .toBe() downgrades, @Disabled, and tautological tests.</span>
          </div>
        </div>
        <div class="checkbox-item">
          <input type="checkbox" id="forbidNewDeps" checked />
          <div class="checkbox-label">
            <strong>Forbid New Dependencies</strong>
            <span>Stops hallucinated packages and unvetted additions to package.json / requirements.txt.</span>
          </div>
        </div>
        <div class="checkbox-item">
          <input type="checkbox" id="forbidHighRisk" checked />
          <div class="checkbox-label">
            <strong>Forbid High-Risk Files</strong>
            <span>Protects CI/CD workflows, Dockerfiles, Terraform configs, and environment variables.</span>
          </div>
        </div>
        <div class="checkbox-item">
          <input type="checkbox" id="forbidArchDrift" />
          <div class="checkbox-label">
            <strong>Enforce Architecture Boundaries</strong>
            <span>Evaluates code imports against Mermaid (.mmd) or Draw.io (.drawio) system diagrams.</span>
          </div>
        </div>
      </div>
    </div>

    <div class="form-group" id="diagramGroup" style="display: none;">
      <label for="diagram">Architecture Diagram</label>
      <div class="hint">Select a diagram from your repository to enforce:</div>
      <select id="diagram" onchange="renderSelectedDiagramNodes()">${diagramOptions}</select>
      <div id="diagramNodesSection" style="margin-top: 12px; display: none;">
        <label>Diagram Nodes & Scoping Shortcuts</label>
        <div class="hint">Click to add node paths to modify scope or lock as read-only:</div>
        <div id="diagramNodesContainer" class="node-cards-grid"></div>
      </div>
    </div>

    <div class="form-group">
      <div class="checkbox-item">
        <input type="checkbox" id="allowExceptions" checked />
        <div class="checkbox-label">
          <strong>Allow Waivers (allow_exceptions)</strong>
          <span>Permits developers to record documented, audit-trailed waivers for intentional exceptions.</span>
        </div>
      </div>
    </div>

    <div class="actions-bar">
      <button type="button" class="btn btn-primary" onclick="submitContract('saveAndStart')">
        ▶ Save & Start Session
      </button>
      <button type="button" class="btn btn-secondary" onclick="submitContract('saveOnly')">
        💾 Save Contract Template
      </button>
      <button type="button" class="btn btn-secondary" onclick="submitContract('copyPrompt')">
        📋 Copy AI Agent Prompt
      </button>
    </div>
  </form>

  <script>
    const vscode = acquireVsCodeApi();
    const diagramsData = ${JSON.stringify(context.diagrams)};

    const archDriftCheckbox = document.getElementById('forbidArchDrift');
    const diagramGroup = document.getElementById('diagramGroup');

    archDriftCheckbox.addEventListener('change', () => {
      diagramGroup.style.display = archDriftCheckbox.checked ? 'block' : 'none';
      if (archDriftCheckbox.checked) {
        renderSelectedDiagramNodes();
      }
    });

    function renderSelectedDiagramNodes() {
      const select = document.getElementById('diagram');
      const container = document.getElementById('diagramNodesContainer');
      const section = document.getElementById('diagramNodesSection');
      const selectedPath = select.value;
      const diagram = diagramsData.find(d => d.path === selectedPath);

      if (!diagram || !diagram.nodes || diagram.nodes.length === 0) {
        section.style.display = 'none';
        container.innerHTML = '';
        return;
      }

      section.style.display = 'block';
      container.innerHTML = diagram.nodes.map(function(n) {
        var pathsJson = JSON.stringify(n.paths).replace(/"/g, '&quot;');
        return '<div class="node-card">' +
          '<div class="node-card-title">Node: ' + (n.label || n.id) + '</div>' +
          '<div class="node-card-paths">' + n.paths.join(', ') + '</div>' +
          '<div class="node-card-actions">' +
            '<button type="button" class="badge-btn" onclick="addNodePaths(' + pathsJson + ', \\'modify\\')">+ Modify</button>' +
            '<button type="button" class="badge-btn" onclick="addNodePaths(' + pathsJson + ', \\'readOnly\\')">🔒 Read-Only</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function addNodePaths(paths, targetId) {
      const textarea = document.getElementById(targetId);
      const lines = textarea.value.split('\\n').map(l => l.trim()).filter(Boolean);
      for (const p of paths) {
        if (!lines.includes(p)) {
          lines.push(p);
        }
      }
      textarea.value = lines.join('\\n');
    }

    function addModifyPath(path) {
      const textarea = document.getElementById('modify');
      const lines = textarea.value.split('\\n').map(l => l.trim()).filter(Boolean);
      if (!lines.includes(path)) {
        lines.push(path);
        textarea.value = lines.join('\\n');
      }
    }

    function addSymbol(sym) {
      const input = document.getElementById('symbols');
      const current = input.value.split(',').map(s => s.trim()).filter(Boolean);
      if (!current.includes(sym)) {
        current.push(sym);
        input.value = current.join(', ');
      }
    }

    function buildContractData() {
      const name = document.getElementById('name').value.trim();
      const intent = document.getElementById('intent').value.trim();
      if (!name || !intent) {
        alert('Please fill in both Contract Name and Task Intent.');
        return null;
      }

      const modifyLines = document.getElementById('modify').value.split('\\n').map(l => l.trim()).filter(Boolean);
      if (modifyLines.length === 0) {
        alert('At least one modify path must be specified.');
        return null;
      }

      const readOnlyLines = document.getElementById('readOnly').value.split('\\n').map(l => l.trim()).filter(Boolean);
      const symbolList = document.getElementById('symbols').value.split(',').map(s => s.trim()).filter(Boolean);

      const forbid = [];
      if (document.getElementById('forbidTestWeakening').checked) forbid.push('test_weakening');
      if (document.getElementById('forbidNewDeps').checked) forbid.push('new_dependencies');
      if (document.getElementById('forbidHighRisk').checked) forbid.push('high_risk_files');
      if (archDriftCheckbox.checked) forbid.push('architecture_drift');

      const allowExceptions = document.getElementById('allowExceptions').checked;

      const payload = {
        name,
        intent,
        scope: {
          modify: modifyLines,
          read_only: readOnlyLines,
          modify_symbols: symbolList
        },
        forbid,
        allow_exceptions: allowExceptions
      };

      if (archDriftCheckbox.checked) {
        const diagramPath = document.getElementById('diagram').value;
        if (!diagramPath) {
          alert('Please select an architecture diagram or uncheck Enforce Architecture Boundaries.');
          return null;
        }
        const diagram = diagramsData.find(d => d.path === diagramPath);
        const nodeMappings = {};
        if (diagram && diagram.nodes && diagram.nodes.length > 0) {
          for (const n of diagram.nodes) {
            nodeMappings[n.id] = n.paths;
          }
        } else {
          nodeMappings['App'] = modifyLines;
        }

        payload.architecture = {
          diagram: diagramPath,
          node_mappings: nodeMappings,
          default_policy: 'deny_unlisted_edges'
        };
      }

      return payload;
    }

    function submitContract(command) {
      const payload = buildContractData();
      if (!payload) return;
      vscode.postMessage({ command, payload });
    }
  </script>
</body>
</html>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
