import * as vscode from "vscode";
import path from "node:path";
import type { Finding } from "../detectors/types";

export class FindingDiagnostics {
  private readonly collection = vscode.languages.createDiagnosticCollection("intent-contract");

  update(root: string | undefined, findings: Finding[]): void {
    this.collection.clear();
    if (!root) return;
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const finding of findings) {
      const filePath = path.join(root, ...finding.file.split("/"));
      const lineIndex = Math.max(0, (finding.line ?? 1) - 1);
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(lineIndex, 0, lineIndex, 1),
        `${finding.message}. Evidence: ${finding.evidence}`,
        finding.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = "Intent Contract";
      diagnostic.code = finding.id;
      const uri = vscode.Uri.file(filePath);
      const list = byFile.get(uri.toString()) ?? [];
      list.push(diagnostic);
      byFile.set(uri.toString(), list);
    }
    for (const [uri, diagnostics] of byFile) this.collection.set(vscode.Uri.parse(uri), diagnostics);
  }

  dispose(): void {
    this.collection.dispose();
  }
}
