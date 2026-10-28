import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { discoverContracts, loadContract, parseContract } from "../contract/loader";
import { ensureIntentMetadataIgnored } from "../contract/template";
import { detectFindingsForWorkspace } from "../detectors";
import type { Contract, Finding, ParsedDiff } from "../detectors/types";
import { diffTrees } from "../git/diff";
import { gitBuffer, gitText } from "../git/cli";
import { captureBaseline, createWorkingTreeSnapshot, releaseBaseline } from "../git/snapshot";
import { revertFileToBaseline } from "../git/revert";
import { readSession, removeSession, writeSession, type ContractSession } from "../state/session";
import { readWaivers } from "../state/waivers";
import { formatFindingsForAgent } from "../state/formatViolations";
import { writeViolationSummary } from "../state/violations";
import { toRepoPath } from "../util/paths";

export interface ContractSummary {
  path: string;
  yaml: string;
  contract: Contract;
  session: ContractSession;
}

export interface VerificationResult {
  passed: boolean;
  errorCount: number;
  warningCount: number;
  findings: Finding[];
  remediationInstructions: string;
  diff: ParsedDiff;
  contract: Contract;
  policyTree: string;
}

export async function getActiveContract(root: string): Promise<ContractSummary> {
  const session = await readSession(root);
  if (!session) throw new Error("No active Intent Contract session was found. Start a contract first.");
  const repoPath = normalizeContractPath(session.activeContract, root);
  const yaml = (await gitBuffer(root, ["cat-file", "blob", session.baselineTreeHash + ":" + repoPath])).toString("utf8");
  return { path: repoPath, yaml, contract: parseContract(yaml, repoPath), session };
}

export async function verifyIntentContract(
  root: string,
  options: { base?: string; contractPath?: string } = {}
): Promise<VerificationResult> {
  const session = await readSession(root);
  let policyTree: string;
  if (options.base) {
    policyTree = (await gitText(root, ["rev-parse", "--verify", options.base + "^{tree}"])).trim();
  } else if (session) {
    policyTree = session.originalBaselineTreeHash ?? session.baselineTreeHash;
  } else {
    policyTree = (await gitText(root, ["rev-parse", "--verify", "HEAD^{tree}"])).trim();
  }

  const contractFile = options.contractPath
    ? normalizeContractPath(options.contractPath, root)
    : session?.activeContract;
  if (!contractFile) throw new Error("No active contract. Start one or pass --contract <path>.");
  const contractYaml = (await gitBuffer(root, ["cat-file", "blob", policyTree + ":" + contractFile])).toString("utf8");
  const contract = parseContract(contractYaml, contractFile);

  const currentTree = await createWorkingTreeSnapshot(root);
  const diff = await diffTrees(root, policyTree, currentTree);
  const allFindings = await detectFindingsForWorkspace(root, policyTree, diff, contract, contractFile);
  const waivers = contract.allow_exceptions ? await readWaivers(root) : new Map();
  const findings = allFindings.filter((finding) => !waivers.has(finding.id));
  try {
    await writeViolationSummary(root, allFindings, waivers);
  } catch {
    // Ignore if directory cannot be written
  }
  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  return {
    passed: errorCount === 0,
    errorCount,
    warningCount,
    findings,
    remediationInstructions: formatFindingsForAgent(findings),
    diff,
    contract,
    policyTree
  };
}

export async function startIntentContract(
  root: string,
  name: string,
  options: { force?: boolean } = {}
): Promise<ContractSummary> {
  const files = await discoverContracts(root);
  const candidates: Array<{ file: string; contract: Contract }> = [];
  const invalidMatches: Array<{ file: string; message: string }> = [];
  for (const file of files) {
    const baseName = path.basename(file, path.extname(file));
    try {
      const contract = await loadContract(file);
      if (contract.name === name || baseName === name) {
        candidates.push({ file, contract });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (baseName === name) {
        invalidMatches.push({ file, message });
      } else {
        try {
          const raw = await fs.readFile(file, "utf8");
          const parsed = parse(raw) as Record<string, unknown> | null;
          if (parsed && typeof parsed === "object" && parsed.name === name) {
            invalidMatches.push({ file, message });
          }
        } catch {
          // Ignore
        }
      }
    }
  }
  if (candidates.length === 0) {
    if (invalidMatches.length > 0) {
      throw new Error(`Contract "${name}" is invalid: ${invalidMatches[0].message}`);
    }
    throw new Error("No valid contract named \"" + name + "\" was found in .intent/.");
  }
  if (candidates.length > 1) {
    throw new Error("More than one contract matches \"" + name + "\". Use a unique contract name or filename.");
  }

  const previous = await readSession(root);
  if (previous) await releaseBaseline(root, previous.baselineRef);
  await ensureIntentMetadataIgnored(root);
  const relative = toRepoPath(path.relative(root, candidates[0].file));
  const snapshot = await captureBaseline(root);
  const originalBaselineTreeHash = options.force
    ? snapshot.baselineTreeHash
    : (previous?.originalBaselineTreeHash ?? previous?.baselineTreeHash ?? snapshot.baselineTreeHash);
  const session: ContractSession = { ...snapshot, activeContract: relative, originalBaselineTreeHash };
  await writeSession(root, session);
  await unlinkIfPresent(path.join(root, ".intent", ".violations.md"));
  const baselineYaml = (await gitBuffer(root, ["cat-file", "blob", snapshot.baselineTreeHash + ":" + relative])).toString("utf8");
  return { path: relative, yaml: baselineYaml, contract: parseContract(baselineYaml, relative), session };
}

export async function stopIntentContract(root: string): Promise<void> {
  const session = await readSession(root);
  if (session) await releaseBaseline(root, session.baselineRef);
  await removeSession(root);
  await unlinkIfPresent(path.join(root, ".intent", ".violations.md"));
}

export async function revertOutOfScopeFiles(root: string, files?: string[]): Promise<string[]> {
  const session = await readSession(root);
  if (!session) throw new Error("No active Intent Contract session was found.");
  const summary = await getActiveContract(root);
  const policyTree = session.originalBaselineTreeHash ?? session.baselineTreeHash;
  const currentTree = await createWorkingTreeSnapshot(root);
  const diff = await diffTrees(root, policyTree, currentTree);
  const allFindings = await detectFindingsForWorkspace(root, policyTree, diff, summary.contract, summary.path);
  const violatingFiles = new Set(allFindings.map((finding) => finding.file));
  const requested = files?.map((file) => normalizeContractPath(file, root));
  if (requested) {
    const invalid = requested.filter((file) => !violatingFiles.has(file));
    if (invalid.length > 0) throw new Error("These files do not have active scope violations: " + invalid.join(", "));
  }
  const selected = requested ?? [...violatingFiles];
  for (const file of selected) {
    const change = diff.changes.find((item) => item.file === file || item.oldFile === file || item.newFile === file);
    if (!change) continue;
    await revertFileToBaseline(root, policyTree, change);
  }
  return selected;
}

export async function revertIntentFile(root: string, file: string): Promise<void> {
  const session = await readSession(root);
  if (!session) throw new Error("No active Intent Contract session was found.");
  const repoPath = normalizeContractPath(file, root);
  const policyTree = session.originalBaselineTreeHash ?? session.baselineTreeHash;
  const currentTree = await createWorkingTreeSnapshot(root);
  const diff = await diffTrees(root, policyTree, currentTree);
  const change = diff.changes.find((item) => item.file === repoPath || item.oldFile === repoPath || item.newFile === repoPath);
  if (!change) throw new Error("The file has no changes relative to the active baseline: " + repoPath);
  await revertFileToBaseline(root, policyTree, change);
}

export function normalizeContractPath(value: string, root = process.cwd()): string {
  const absolute = path.isAbsolute(value);
  let relative = absolute ? path.relative(root, value) : value;
  relative = toRepoPath(relative);
  if (!relative || relative.startsWith("/") || relative.split("/").some((segment) => segment === "..")) {
    throw new Error("Unsafe repository path: " + value);
  }
  return relative;
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
