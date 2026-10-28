import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs/promises";
import { parse, stringify } from "yaml";
import { discoverContracts } from "../contract/loader";
import { createDefaultContract } from "../contract/template";
import { gitText } from "../git/cli";
import { updateContractInBaseline } from "../git/snapshot";
import { policyTreeHash } from "../runtime/contracts";
import { writeSession, type ContractSession } from "../state/session";
import { toRepoPath } from "../util/paths";

interface ScopeContract {
  name?: string;
  intent?: string;
  scope?: {
    modify?: string[];
    read_only?: string[];
    modify_symbols?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export async function addSymbolToScope(
  root: string,
  getSession: () => ContractSession | undefined,
  onReload: () => Promise<void>,
  symbolOverride?: string
): Promise<void> {
  let symbol = symbolOverride?.trim();
  if (!symbol) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const selectionText = editor.document.getText(editor.selection).trim();
      if (selectionText && !selectionText.includes("\n") && selectionText.length < 100) {
        symbol = selectionText;
      } else {
        const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
        if (wordRange) {
          symbol = editor.document.getText(wordRange).trim();
        }
      }
    }
  }

  if (!symbol) {
    symbol = await vscode.window.showInputBox({
      prompt: "Enter symbol name (function, class, variable) to allow modifying in the active scope",
      placeHolder: "e.g. calculateTotal, UserService, parseConfig"
    });
    symbol = symbol?.trim();
  }

  if (!symbol) return;

  const target = await resolveContractFile(root, getSession());
  if (!target) return;

  const contractAbsPath = path.join(root, target.repoPath);
  const rawYaml = await fs.readFile(contractAbsPath, "utf8");
  const parsed = (parse(rawYaml) ?? {}) as ScopeContract;

  if (!parsed.scope) parsed.scope = {};
  if (!Array.isArray(parsed.scope.modify_symbols)) {
    parsed.scope.modify_symbols = [];
  }

  if (parsed.scope.modify_symbols.includes(symbol)) {
    void vscode.window.showInformationMessage(`Symbol "${symbol}" is already in scope.modify_symbols for "${parsed.name ?? target.repoPath}".`);
    return;
  }

  parsed.scope.modify_symbols.push(symbol);
  await fs.writeFile(contractAbsPath, stringify(parsed), "utf8");

  const session = getSession();
  if (session && session.activeContract === target.repoPath) {
    await syncBaselineContract(root, session, target.repoPath);
    await onReload();
  }

  void vscode.window.showInformationMessage(`Added symbol "${symbol}" to scope.modify_symbols in ${parsed.name ?? target.repoPath}.`);
}

export async function addFileToScope(
  root: string,
  getSession: () => ContractSession | undefined,
  onReload: () => Promise<void>,
  uriOverride?: vscode.Uri
): Promise<void> {
  const fileUri = uriOverride ?? vscode.window.activeTextEditor?.document.uri;
  if (!fileUri || fileUri.scheme !== "file") {
    void vscode.window.showWarningMessage("No file selected or active editor to add to scope.");
    return;
  }

  const relative = toRepoPath(path.relative(root, fileUri.fsPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    void vscode.window.showErrorMessage(`File "${fileUri.fsPath}" is outside the repository workspace.`);
    return;
  }

  const target = await resolveContractFile(root, getSession());
  if (!target) return;

  const contractAbsPath = path.join(root, target.repoPath);
  const rawYaml = await fs.readFile(contractAbsPath, "utf8");
  const parsed = (parse(rawYaml) ?? {}) as ScopeContract;

  if (!parsed.scope) parsed.scope = {};
  if (!Array.isArray(parsed.scope.modify)) parsed.scope.modify = [];

  // If in read_only, remove it
  if (Array.isArray(parsed.scope.read_only)) {
    parsed.scope.read_only = parsed.scope.read_only.filter((p) => p !== relative);
  }

  if (parsed.scope.modify.includes(relative)) {
    void vscode.window.showInformationMessage(`File "${relative}" is already in scope.modify.`);
    return;
  }

  parsed.scope.modify.push(relative);
  await fs.writeFile(contractAbsPath, stringify(parsed), "utf8");

  const session = getSession();
  if (session && session.activeContract === target.repoPath) {
    await syncBaselineContract(root, session, target.repoPath);
    await onReload();
  }

  void vscode.window.showInformationMessage(`Added "${relative}" to scope.modify in ${parsed.name ?? target.repoPath}.`);
}

export async function markFileReadOnly(
  root: string,
  getSession: () => ContractSession | undefined,
  onReload: () => Promise<void>,
  uriOverride?: vscode.Uri
): Promise<void> {
  const fileUri = uriOverride ?? vscode.window.activeTextEditor?.document.uri;
  if (!fileUri || fileUri.scheme !== "file") {
    void vscode.window.showWarningMessage("No file selected or active editor to mark read-only.");
    return;
  }

  const relative = toRepoPath(path.relative(root, fileUri.fsPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    void vscode.window.showErrorMessage(`File "${fileUri.fsPath}" is outside the repository workspace.`);
    return;
  }

  const target = await resolveContractFile(root, getSession());
  if (!target) return;

  const contractAbsPath = path.join(root, target.repoPath);
  const rawYaml = await fs.readFile(contractAbsPath, "utf8");
  const parsed = (parse(rawYaml) ?? {}) as ScopeContract;

  if (!parsed.scope) parsed.scope = {};
  if (!Array.isArray(parsed.scope.read_only)) parsed.scope.read_only = [];

  // If in modify, remove it
  if (Array.isArray(parsed.scope.modify)) {
    parsed.scope.modify = parsed.scope.modify.filter((p) => p !== relative);
  }

  if (parsed.scope.read_only.includes(relative)) {
    void vscode.window.showInformationMessage(`File "${relative}" is already in scope.read_only.`);
    return;
  }

  parsed.scope.read_only.push(relative);
  await fs.writeFile(contractAbsPath, stringify(parsed), "utf8");

  const session = getSession();
  if (session && session.activeContract === target.repoPath) {
    await syncBaselineContract(root, session, target.repoPath);
    await onReload();
  }

  void vscode.window.showInformationMessage(`Marked "${relative}" as read_only in ${parsed.name ?? target.repoPath}.`);
}

export async function addPathPatternToScope(
  root: string,
  session: ContractSession | undefined,
  onReload: () => Promise<void>,
  pattern: string,
  mode: "modify" | "read_only"
): Promise<void> {
  const target = await resolveContractFile(root, session);
  if (!target) return;

  const contractAbsPath = path.join(root, target.repoPath);
  const rawYaml = await fs.readFile(contractAbsPath, "utf8");
  const parsed = (parse(rawYaml) ?? {}) as ScopeContract;

  if (!parsed.scope) parsed.scope = {};
  if (!Array.isArray(parsed.scope.modify)) parsed.scope.modify = [];
  if (!Array.isArray(parsed.scope.read_only)) parsed.scope.read_only = [];

  if (mode === "modify") {
    parsed.scope.read_only = parsed.scope.read_only.filter((p) => p !== pattern);
    if (!parsed.scope.modify.includes(pattern)) {
      parsed.scope.modify.push(pattern);
    }
  } else {
    parsed.scope.modify = parsed.scope.modify.filter((p) => p !== pattern);
    if (!parsed.scope.read_only.includes(pattern)) {
      parsed.scope.read_only.push(pattern);
    }
  }

  await fs.writeFile(contractAbsPath, stringify(parsed), "utf8");

  if (session && session.activeContract === target.repoPath) {
    await syncBaselineContract(root, session, target.repoPath);
    await onReload();
  }
}

async function resolveContractFile(
  root: string,
  session: ContractSession | undefined
): Promise<{ repoPath: string } | undefined> {
  if (session?.activeContract) {
    return { repoPath: session.activeContract };
  }

  const contracts = await discoverContracts(root);
  if (contracts.length === 0) {
    const action = await vscode.window.showWarningMessage(
      "No contract files found in .intent/. Would you like to create default.yaml?",
      "Create Contract",
      "Cancel"
    );
    if (action === "Create Contract") {
      const createdPath = await createDefaultContract(root);
      return { repoPath: toRepoPath(path.relative(root, createdPath)) };
    }
    return undefined;
  }

  if (contracts.length === 1) {
    return { repoPath: toRepoPath(path.relative(root, contracts[0])) };
  }

  const pickItems = contracts.map((filePath) => ({
    label: path.basename(filePath),
    description: toRepoPath(path.relative(root, filePath)),
    repoPath: toRepoPath(path.relative(root, filePath))
  }));

  const selected = await vscode.window.showQuickPick(pickItems, {
    placeHolder: "Select contract file to modify"
  });

  return selected ? { repoPath: selected.repoPath } : undefined;
}

async function syncBaselineContract(
  root: string,
  session: ContractSession,
  contractRepoPath: string
): Promise<void> {
  try {
    const blobSha = (await gitText(root, ["hash-object", "-w", contractRepoPath])).trim();
    const currentBaseTree = policyTreeHash(session);
    const newBaseTree = await updateContractInBaseline(root, currentBaseTree, contractRepoPath, blobSha);
    session.baselineTreeHash = newBaseTree;
    session.originalBaselineTreeHash = newBaseTree;
    if (session.baselineRef) {
      await gitText(root, ["update-ref", session.baselineRef, newBaseTree]);
    }
    await writeSession(root, session);
  } catch (err) {
    // If baseline synchronization fails, the file change on disk is still preserved.
    void vscode.window.showWarningMessage(
      `Updated contract on disk, but could not sync active Git baseline: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

