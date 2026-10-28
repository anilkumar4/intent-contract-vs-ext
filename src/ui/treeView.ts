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
  command?: vscode.Command;
  icon?: vscode.ThemeIcon;
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
      const item = new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
      if (element.command) item.command = element.command;
      if (element.icon) item.iconPath = element.icon;
      return item;
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
    if (roots.length === 0) {
      if (this.active) {
        roots.push(
          {
            kind: "empty",
            message: "No active findings (100% compliant)",
            icon: new vscode.ThemeIcon("pass-filled")
          },
          {
            kind: "empty",
            message: "Open Mission Control Dashboard...",
            icon: new vscode.ThemeIcon("dashboard"),
            command: { command: "intentContract.openDashboard", title: "Open Mission Control Dashboard" }
          },
          {
            kind: "empty",
            message: "Open Architecture Drift Inspector...",
            icon: new vscode.ThemeIcon("graph"),
            command: { command: "intentContract.visualizeArchitecture", title: "Open Architecture Drift Inspector" }
          }
        );
      } else {
        roots.push(
          {
            kind: "empty",
            message: "Start a Contract Session...",
            icon: new vscode.ThemeIcon("play"),
            command: { command: "intentContract.start", title: "Start Contract" }
          },
          {
            kind: "empty",
            message: "Visual Contract Builder...",
            icon: new vscode.ThemeIcon("symbol-event"),
            command: { command: "intentContract.visualBuilder", title: "Visual Contract Builder" }
          },
          {
            kind: "empty",
            message: "Configure AI Agents & MCP...",
            icon: new vscode.ThemeIcon("hubot"),
            command: { command: "intentContract.configureAgents", title: "Configure AI Agents" }
          },
          {
            kind: "empty",
            message: "Getting Started Walkthrough...",
            icon: new vscode.ThemeIcon("rocket"),
            command: { command: "intentContract.openWalkthrough", title: "Open Walkthrough" }
          },
          {
            kind: "empty",
            message: "Open Vibe Coding Guide...",
            icon: new vscode.ThemeIcon("book"),
            command: { command: "intentContract.openGuide", title: "Open Vibe Coding Guide" }
          }
        );
      }
    }
    return roots;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
