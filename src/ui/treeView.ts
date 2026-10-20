import * as vscode from "vscode";
import type { Finding } from "../detectors/types";
import type { Waiver } from "../state/waivers";

type TreeNode = FileGroupNode | WaivedGroupNode | FindingNode | EmptyNode;

interface FileGroupNode {
  kind: "file";
  file: string;
  findings: Finding[];
}

interface WaivedGroupNode {
  kind: "waivedGroup";
  findings: Finding[];
  waivers: Map<string, Waiver>;
}

interface FindingNode {
  kind: "finding";
  finding: Finding;
  waiver?: Waiver;
}

interface EmptyNode {
  kind: "empty";
  message: string;
}

export class FindingsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private findings: Finding[] = [];
  private waivers = new Map<string, Waiver>();
  private active = false;

  setState(active: boolean, findings: Finding[], waivers: Map<string, Waiver>): void {
    this.active = active;
    this.findings = findings;
    this.waivers = waivers;
    this.changed.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === "file") {
      const item = new vscode.TreeItem(element.file, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = "intentFileGroup";
      item.iconPath = new vscode.ThemeIcon("file");
      return item;
    }
    if (element.kind === "waivedGroup") {
      const item = new vscode.TreeItem("Waived Findings", vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = "intentWaivedGroup";
      item.iconPath = new vscode.ThemeIcon("shield");
      return item;
    }
    if (element.kind === "empty") {
      return new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
    }
    const { finding, waiver } = element;
    const item = new vscode.TreeItem(finding.message, vscode.TreeItemCollapsibleState.None);
    item.description = `${finding.detector} · ${finding.severity}${finding.line ? ` · line ${finding.line}` : ""}`;
    item.tooltip = `${finding.file}${finding.line ? `:${finding.line}` : ""}\n${finding.evidence}${waiver ? `\nReason: ${waiver.reason}` : ""}`;
    item.contextValue = waiver ? "intentWaivedFinding" : "intentFinding";
    item.iconPath = waiver
      ? new vscode.ThemeIcon("check")
      : new vscode.ThemeIcon(finding.severity === "error" ? "error" : "warning");
    if (!waiver) {
      item.command = {
        command: "intentContract.openDiff",
        title: "Open Diff vs Baseline",
        arguments: [finding]
      };
    }
    return item;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element?.kind === "file") {
      return element.findings.map((finding) => ({ kind: "finding", finding }));
    }
    if (element?.kind === "waivedGroup") {
      return element.findings.map((finding) => ({ kind: "finding", finding, waiver: this.waivers.get(finding.id) }));
    }
    if (element) return [];

    const activeFindings = this.findings.filter((finding) => !this.waivers.has(finding.id));
    const waivedFindings = this.findings.filter((finding) => this.waivers.has(finding.id));
    const groups = new Map<string, Finding[]>();
    for (const finding of activeFindings) {
      const list = groups.get(finding.file) ?? [];
      list.push(finding);
      groups.set(finding.file, list);
    }
    const roots: TreeNode[] = [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, items]) => ({ kind: "file", file, findings: items }));
    if (waivedFindings.length > 0) roots.push({ kind: "waivedGroup", findings: waivedFindings, waivers: this.waivers });
    if (roots.length === 0) roots.push({ kind: "empty", message: this.active ? "No active findings" : "Start a contract to monitor changes" });
    return roots;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
