import * as vscode from "vscode";
import type { Finding } from "../detectors/types";

export class ContractStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
    this.item.command = "intentContract.statusClick";
    this.item.show();
  }

  update(contractName: string | undefined, findings: Finding[]): void {
    if (!contractName) {
      this.item.text = "$(shield) Intent: Off";
      this.item.backgroundColor = undefined;
      this.item.tooltip = "Start a local Intent Contract to detect changes against a baseline.";
      return;
    }
    this.item.text = `$(shield) Contract: ${contractName} · ${findings.length} ${findings.length === 1 ? "violation" : "violations"}`;
    const hasError = findings.some((finding) => finding.severity === "error");
    this.item.backgroundColor = findings.length === 0
      ? undefined
      : new vscode.ThemeColor(hasError ? "statusBarItem.errorBackground" : "statusBarItem.warningBackground");
    this.item.tooltip = findings.length === 0
      ? "No active findings. Intent Contract detects changes after they are written."
      : "Intent Contract detects changes after they are written. Click to view findings.";
  }

  dispose(): void {
    this.item.dispose();
  }
}
