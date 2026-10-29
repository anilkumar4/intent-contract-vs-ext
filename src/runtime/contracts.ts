import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { discoverContracts, loadContract, parseContract } from "../contract/loader";
import { ensureIntentMetadataIgnored } from "../contract/template";
import { detectFindingsForWorkspace } from "../detectors";
import type { Contract, Finding, ParsedDiff } from "../detectors/types";
import { diffTrees } from "../git/diff";
import { gitBuffer, gitText } from "../git/cli";
import {
  captureBaseline,
  createIndexCandidateTree,
  createRevisionCandidateTree,
  createWorkingTreeSnapshot,
  materializeTree,
  releaseBaseline
} from "../git/snapshot";
import { revertFileToBaseline } from "../git/revert";
import { readSession, removeSession, writeSession, type ContractSession } from "../state/session";
import { readWaiversForContract } from "../state/waivers";
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
  const existing = await readSession(root);
  if (!existing) throw new Error("No active Intent Contract session was found. Start a contract first.");
  const session = await ensurePolicyBaselineRef(root, existing);
  const repoPath = normalizeContractPath(session.activeContract, root);
  const yaml = (await gitBuffer(root, ["cat-file", "blob", policyTreeHash(session) + ":" + repoPath])).toString("utf8");
  return { path: repoPath, yaml, contract: parseContract(yaml, repoPath), session };
}

export async function verifyIntentContract(
  root: string,
  options: { base?: string; contractPath?: string; index?: boolean; revision?: string } = {}
): Promise<VerificationResult> {
  if (options.index && options.revision) throw new Error("--index and --revision cannot be used together.");
  let session = await readSession(root);
  if (session) session = await ensurePolicyBaselineRef(root, session);
  if ((options.index || options.revision) && !session) {
    throw new Error("--index and --revision require an active Intent Contract session.");
  }
  let policyTree: string;
  if (options.base) {
    policyTree = (await gitText(root, ["rev-parse", "--verify", options.base + "^{tree}"])).trim();
  } else if (session) {
    policyTree = policyTreeHash(session);
  } else {
    policyTree = (await gitText(root, ["rev-parse", "--verify", "HEAD^{tree}"])).trim();
  }

  const contractFile = options.contractPath
    ? normalizeContractPath(options.contractPath, root)
    : session?.activeContract;
  if (!contractFile) throw new Error("No active contract. Start one or pass --contract <path>.");
  const contractYaml = (await gitBuffer(root, ["cat-file", "blob", policyTree + ":" + contractFile])).toString("utf8");
  const contract = parseContract(contractYaml, contractFile);

  const currentTree = options.index
    ? await createIndexCandidateTree(root, policyTree, session?.headSha ?? null)
    : options.revision
      ? await createRevisionCandidateTree(
        root,
        policyTree,
        session?.headSha ?? null,
        (await gitText(root, ["rev-parse", "--verify", "--end-of-options", options.revision + "^{commit}"])).trim()
      )
      : await createWorkingTreeSnapshot(root, contract.scope.read_only);
  const diff = await diffTrees(root, policyTree, currentTree);
  const candidateCheckout = options.index || options.revision ? await materializeTree(root, currentTree) : undefined;
  let allFindings: Finding[];
  try {
    allFindings = await detectFindingsForWorkspace(root, policyTree, diff, contract, contractFile, candidateCheckout?.root ?? root);
  } finally {
    await candidateCheckout?.dispose();
  }
  const waivers = await readWaiversForContract(root, contract.allow_exceptions);
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

  return withRepoLock(root, async () => {
    const previous = await readSession(root);
    if (previous && !options.force) {
      throw new Error("An Intent Contract session is already active. Use --force to replace its baseline, or stop it first.");
    }
    await ensureIntentMetadataIgnored(root);
    const relative = toRepoPath(path.relative(root, candidates[0].file));
    const snapshot = await captureBaseline(root, candidates[0].contract.scope.read_only);
    const session: ContractSession = {
      ...snapshot,
      activeContract: relative,
      originalBaselineTreeHash: snapshot.baselineTreeHash
    };
    try {
      await writeSession(root, session);
    } catch (error) {
      await releaseBaseline(root, snapshot.baselineRef);
      throw error;
    }
    if (previous) await releaseSessionBaselineRefs(root, previous);
    await pruneOrphanBaselineRefs(root, new Set([session.baselineRef, session.originalBaselineRef].filter(Boolean) as string[]));
    await unlinkIfPresent(path.join(root, ".intent", ".violations.md"));
    const baselineYaml = (await gitBuffer(root, ["cat-file", "blob", snapshot.baselineTreeHash + ":" + relative])).toString("utf8");
    return { path: relative, yaml: baselineYaml, contract: parseContract(baselineYaml, relative), session };
  });
}

export async function stopIntentContract(root: string): Promise<void> {
  return withRepoLock(root, async () => {
    const session = await readSession(root);
    if (session) await releaseSessionBaselineRefs(root, session);
    await removeSession(root);
    await pruneOrphanBaselineRefs(root, new Set());
    await unlinkIfPresent(path.join(root, ".intent", ".violations.md"));
  });
}

async function withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = path.join(root, ".git");
  await fs.mkdir(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, "intent-contract.lock");
  const maxAttempts = 60;
  let handle: fs.FileHandle | undefined;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      handle = await fs.open(lockFile, "wx");
      break;
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "EEXIST") {
        try {
          const stat = await fs.stat(lockFile);
          if (Date.now() - stat.mtimeMs > 10000) {
            await fs.unlink(lockFile).catch(() => {});
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      throw err;
    }
  }
  if (!handle) {
    throw new Error("Could not acquire lock on .git/intent-contract.lock (timed out)");
  }
  try {
    return await fn();
  } finally {
    try {
      await handle.close();
      await fs.unlink(lockFile);
    } catch {}
  }
}

async function pruneOrphanBaselineRefs(root: string, activeRefs: Set<string>): Promise<void> {
  try {
    const raw = await gitText(root, ["for-each-ref", "--format=%(refname)", "refs/intent-contract/baselines/"]);
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const ref of lines) {
      if (!activeRefs.has(ref)) {
        await gitText(root, ["update-ref", "-d", ref]).catch(() => {});
      }
    }
  } catch {
    // Ignore if git command fails
  }
}

export async function revertOutOfScopeFiles(root: string, files?: string[]): Promise<string[]> {
  const existing = await readSession(root);
  if (!existing) throw new Error("No active Intent Contract session was found.");
  const session = await ensurePolicyBaselineRef(root, existing);
  const summary = await getActiveContract(root);
  const policyTree = policyTreeHash(session);
  const currentTree = await createWorkingTreeSnapshot(root, summary.contract.scope.read_only);
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
  const existing = await readSession(root);
  if (!existing) throw new Error("No active Intent Contract session was found.");
  const session = await ensurePolicyBaselineRef(root, existing);
  const repoPath = normalizeContractPath(file, root);
  const policyTree = policyTreeHash(session);
  const active = await getActiveContract(root);
  const currentTree = await createWorkingTreeSnapshot(root, active.contract.scope.read_only);
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

export function policyTreeHash(session: ContractSession): string {
  return session.originalBaselineTreeHash ?? session.baselineTreeHash;
}

export async function ensurePolicyBaselineRef(root: string, session: ContractSession): Promise<ContractSession> {
  const policyTree = policyTreeHash(session);
  if (policyTree === session.baselineTreeHash) return session;
  if (session.originalBaselineRef) {
    try {
      const pinnedTree = (await gitText(root, ["rev-parse", "--verify", `${session.originalBaselineRef}^{tree}`])).trim();
      if (pinnedTree === policyTree) return session;
    } catch {
      // Recreate a missing or stale ref below if the tree itself is still available.
    }
  }

  try {
    await gitText(root, ["cat-file", "-e", `${policyTree}^{tree}`]);
  } catch {
    throw new Error(
      `The active policy baseline ${policyTree} is no longer available in Git. Stop the session and start a new baseline with --force.`
    );
  }

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const originalBaselineRef = session.originalBaselineRef ?? `refs/intent-contract/baselines/policy-${suffix}`;
  await gitText(root, ["update-ref", originalBaselineRef, policyTree]);
  const updated = { ...session, originalBaselineRef };
  try {
    await writeSession(root, updated);
  } catch (error) {
    if (!session.originalBaselineRef) await releaseBaseline(root, originalBaselineRef);
    throw error;
  }
  return updated;
}

export async function releaseSessionBaselineRefs(root: string, session: ContractSession): Promise<void> {
  await releaseBaseline(root, session.baselineRef);
  if (session.originalBaselineRef && session.originalBaselineRef !== session.baselineRef) {
    await releaseBaseline(root, session.originalBaselineRef);
  }
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
