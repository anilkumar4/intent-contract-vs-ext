import * as vscode from "vscode";
import path from "node:path";
import type { Contract } from "../contract/schema";
import type { ContractSession } from "../state/session";
import type { Finding } from "../detectors/types";
import { matchesPatterns } from "../detectors/scope";
import { toRepoPath } from "../util/paths";

export interface CodeLensContext {
  root: string | undefined;
  session: ContractSession | undefined;
  contract: Contract | undefined;
  findings: Finding[];
}

export class IntentContractCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.changeEmitter.event;
  private getContext: () => CodeLensContext;

  constructor(getContext: () => CodeLensContext) {
    this.getContext = getContext;
  }

  public refresh(): void {
    this.changeEmitter.fire();
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const config = vscode.workspace.getConfiguration("intentContract");
    if (config.get<boolean>("enableCodeLens", true) === false) {
      return [];
    }

    if (document.uri.scheme !== "file") return [];

    const ctx = this.getContext();
    if (!ctx.root || !ctx.session || !ctx.contract) return [];

    const relative = toRepoPath(path.relative(ctx.root, document.uri.fsPath));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return [];

    // Skip internal repository folders
    if (
      relative.startsWith(".git/") ||
      relative.startsWith(".intent/") ||
      relative.startsWith("node_modules/") ||
      relative.startsWith("dist/") ||
      relative.startsWith("out/")
    ) {
      return [];
    }

    const range = new vscode.Range(0, 0, 0, 0);
    const lenses: vscode.CodeLens[] = [];
    const activeFindings = ctx.findings.filter((f) => f.file === relative);

    const isReadOnly = matchesPatterns(relative, ctx.contract.scope.read_only);
    const isModify = matchesPatterns(relative, ctx.contract.scope.modify);

    if (activeFindings.length > 0) {
      const errorCount = activeFindings.filter((f) => f.severity === "error").length;
      lenses.push(
        new vscode.CodeLens(range, {
          title: errorCount > 0 ? `❌ Intent: ${activeFindings.length} violation(s)` : `⚠️ Intent: ${activeFindings.length} warning(s)`,
          tooltip: activeFindings.map((f) => f.message).join("\n"),
          command: "intentContract.openDiff",
          arguments: [activeFindings[0]]
        })
      );
    }

    if (isReadOnly) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: `🔒 Intent: Read-Only`,
          tooltip: `This file is declared read-only under contract "${ctx.contract.name}".`,
          command: "intentContract.openDashboard"
        }),
        new vscode.CodeLens(range, {
          title: `Allow Editing (Add to Modify)`,
          tooltip: `Add "${relative}" to scope.modify in active contract.`,
          command: "intentContract.addFileToScope",
          arguments: [document.uri]
        })
      );
    } else if (isModify) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: `🛡️ Intent: In-Scope (Modify)`,
          tooltip: `This file is allowed to be modified under contract "${ctx.contract.name}".`,
          command: "intentContract.openDashboard"
        }),
        new vscode.CodeLens(range, {
          title: `Lock as Read-Only`,
          tooltip: `Mark "${relative}" as read-only to prevent further AI changes.`,
          command: "intentContract.markFileReadOnly",
          arguments: [document.uri]
        })
      );
    } else {
      lenses.push(
        new vscode.CodeLens(range, {
          title: `⚠️ Intent: Out of Scope`,
          tooltip: `This file is outside the permitted modify scope of contract "${ctx.contract.name}".`,
          command: "intentContract.openDashboard"
        }),
        new vscode.CodeLens(range, {
          title: `➕ Add File to Scope`,
          tooltip: `Include "${relative}" in scope.modify so AI agents can edit it.`,
          command: "intentContract.addFileToScope",
          arguments: [document.uri]
        }),
        new vscode.CodeLens(range, {
          title: `🔒 Mark Read-Only`,
          tooltip: `Explicitly declare "${relative}" as read-only.`,
          command: "intentContract.markFileReadOnly",
          arguments: [document.uri]
        })
      );
    }

    return lenses;
  }
}
