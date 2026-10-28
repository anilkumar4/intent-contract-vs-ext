import * as vscode from "vscode";
import { gitBuffer } from "../git/cli";
import { policyTreeHash } from "../runtime/contracts";
import type { ContractSession } from "../state/session";

export class BaselineContentProvider implements vscode.TextDocumentContentProvider {
  constructor(
    private readonly getRoot: () => string | undefined,
    private readonly getSession: () => ContractSession | undefined
  ) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const root = this.getRoot();
    const session = this.getSession();
    if (!root || !session) return "No active Intent Contract baseline.";
    const repoPath = uri.path.replace(/^\//, "");
    try {
      const buffer = await gitBuffer(root, ["cat-file", "blob", `${policyTreeHash(session)}:${repoPath}`]);
      return buffer.includes(0) ? "[Binary file in baseline]" : buffer.toString("utf8");
    } catch {
      return "[File did not exist in the baseline]";
    }
  }
}
