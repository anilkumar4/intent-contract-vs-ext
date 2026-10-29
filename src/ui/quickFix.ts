import * as vscode from "vscode";
import path from "node:path";
import type { Finding } from "../detectors/types";
import { toRepoPath } from "../util/paths";

export interface QuickFixContext {
  getRoot: () => string | undefined;
  getFindings: () => Finding[];
}

export class IntentContractCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix
  ];

  private readonly context: QuickFixContext;

  constructor(context: QuickFixContext) {
    this.context = context;
  }

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const root = this.context.getRoot();
    if (!root || document.uri.scheme !== "file") return [];

    const relative = toRepoPath(path.relative(root, document.uri.fsPath));
    const intentDiagnostics = context.diagnostics.filter(
      (diag) => diag.source === "Intent Contract" || diag.source === "intent-contract"
    );

    if (intentDiagnostics.length === 0) return [];

    const actions: vscode.CodeAction[] = [];
    const allFindings = this.context.getFindings();
    const fileFindings = allFindings.filter((f) => f.file === relative);

    for (const diag of intentDiagnostics) {
      // Find matching finding if possible
      const matched = fileFindings.find((f) => diag.message.includes(f.message) || f.message.includes(diag.message));

      if (!matched || matched.detector === "scope") {
        const addFileAction = new vscode.CodeAction(
          `Intent Contract: Add "${relative}" to allowed scope (modify)`,
          vscode.CodeActionKind.QuickFix
        );
        addFileAction.command = {
          command: "intentContract.addFileToScope",
          title: "Add File to Scope",
          arguments: [document.uri]
        };
        addFileAction.isPreferred = true;
        addFileAction.diagnostics = [diag];
        actions.push(addFileAction);

        const revertAction = new vscode.CodeAction(
          `Intent Contract: Revert "${relative}" to baseline snapshot`,
          vscode.CodeActionKind.QuickFix
        );
        revertAction.command = {
          command: "intentContract.revertFile",
          title: "Revert File",
          arguments: [matched ?? { file: relative }]
        };
        revertAction.diagnostics = [diag];
        actions.push(revertAction);
      }

      if (matched?.detector === "symbol_scope") {
        const wordRange = document.getWordRangeAtPosition(range.start);
        const symbol = wordRange ? document.getText(wordRange).trim() : undefined;
        const addSymbolAction = new vscode.CodeAction(
          symbol
            ? `Intent Contract: Add symbol "${symbol}" to scope.modify_symbols`
            : "Intent Contract: Add active symbol to scope.modify_symbols",
          vscode.CodeActionKind.QuickFix
        );
        addSymbolAction.command = {
          command: "intentContract.addSymbolToScope",
          title: "Add Symbol to Scope",
          arguments: [symbol]
        };
        addSymbolAction.isPreferred = true;
        addSymbolAction.diagnostics = [diag];
        actions.push(addSymbolAction);
      }

      if (matched?.detector === "architecture_drift") {
        const archAction = new vscode.CodeAction(
          "Intent Contract: Inspect boundary breach in Architecture Inspector",
          vscode.CodeActionKind.QuickFix
        );
        archAction.command = {
          command: "intentContract.visualizeArchitecture",
          title: "Inspect in Architecture Inspector"
        };
        archAction.isPreferred = true;
        archAction.diagnostics = [diag];
        actions.push(archAction);
      }
    }

    const openDashboardAction = new vscode.CodeAction(
      "Intent Contract: Open Mission Control Dashboard",
      vscode.CodeActionKind.QuickFix
    );
    openDashboardAction.command = {
      command: "intentContract.openDashboard",
      title: "Open Mission Control Dashboard"
    };
    actions.push(openDashboardAction);

    return actions;
  }
}
