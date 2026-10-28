import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitText, optionalHeadSha } from "./cli";
import { toRepoPath } from "../util/paths";
import { highRiskRule } from "../detectors/highRisk";
import { matchesPatterns } from "../detectors/scope";

export interface BaselineSnapshot {
  baselineTreeHash: string;
  headSha: string | null;
  startedAt: string;
  baselineRef: string;
}

const indexPathCache = new Map<string, string>();

async function getIndexPath(root: string): Promise<string> {
  const cached = indexPathCache.get(root);
  if (cached) return cached;
  const resolved = (await gitText(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
  indexPathCache.set(root, resolved);
  return resolved;
}

export async function createWorkingTreeSnapshot(root: string, readOnlyPatterns: string[] = []): Promise<string> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "intent-contract-index-"));
  const temporaryIndexPath = path.join(temporaryDirectory, "index");
  const indexPath = await getIndexPath(root);
  try {
    try {
      await fs.copyFile(indexPath, temporaryIndexPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const env = { GIT_INDEX_FILE: temporaryIndexPath };
      await gitText(root, ["read-tree", "--empty"], env);
    }
    const env = { GIT_INDEX_FILE: temporaryIndexPath };
    await gitText(root, ["add", "-A", "--", "."], env);

    // Include ignored files covered by policy so changes to those paths remain visible.
    try {
      const ignoredRaw = await gitText(root, [
        "status", "--porcelain=v1", "-z", "-uall", "--ignored", "--",
        ":(exclude)node_modules",
        ":(exclude).vscode-test",
        ":(exclude)dist",
        ":(exclude).git"
      ]);
      const fields = ignoredRaw.split("\0");
      const ignoredFiles: string[] = [];
      for (const field of fields) {
        if (!field.startsWith("!! ")) continue;
        const repoFile = toRepoPath(field.slice(3));
        if (
          repoFile.startsWith(".git/") ||
          repoFile.startsWith("node_modules/") ||
          repoFile.startsWith(".vscode-test/") ||
          repoFile.startsWith("dist/")
        ) {
          continue;
        }
        if (shouldTrackIgnoredFile(repoFile, readOnlyPatterns)) {
          ignoredFiles.push(repoFile);
        }
      }
      if (ignoredFiles.length > 0) {
        await gitText(root, ["add", "-f", "--", ...ignoredFiles], env);
      }
    } catch {
      // Continue even if ignored file status fails
    }

    await gitText(root, ["rm", "--cached", "--ignore-unmatch", "--", ".intent/.state.json", ".intent/.violations.md", ".intent/waivers.json"], env);
    return (await gitText(root, ["write-tree"], env)).trim();
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function createIndexCandidateTree(root: string, baseTree: string, baseSha: string | null): Promise<string> {
  const changedPaths = baseSha
    ? await gitText(root, ["diff", "--cached", "--name-only", "-z", "--no-renames", baseSha, "--"])
    : await gitText(root, ["ls-files", "--cached", "-z"]);
  const unmerged = await gitText(root, ["ls-files", "--unmerged", "-z"]);
  if (unmerged) throw new Error("Cannot verify the staged index while merge conflicts remain.");

  return applyCandidatePaths(root, baseTree, changedPaths, async (file) => {
    const output = await gitText(root, ["ls-files", "--stage", "-z", "--", file]);
    const record = output.split("\0").find(Boolean);
    if (!record) return undefined;
    const tab = record.indexOf("\t");
    const [mode, objectId, stage] = record.slice(0, tab).split(" ");
    if (stage !== "0") throw new Error(`Cannot verify staged path ${file} because it has unresolved index entries.`);
    return { mode, objectId };
  });
}

export async function createRevisionCandidateTree(
  root: string,
  baseTree: string,
  baseSha: string | null,
  revision: string
): Promise<string> {
  const changedPaths = baseSha
    ? await gitText(root, ["diff", "--name-only", "-z", "--no-renames", baseSha, revision, "--"])
    : await gitText(root, ["ls-tree", "-r", "-z", "--name-only", revision]);

  return applyCandidatePaths(root, baseTree, changedPaths, async (file) => {
    const output = await gitText(root, ["ls-tree", "-z", revision, "--", file]);
    const record = output.split("\0").find(Boolean);
    if (!record) return undefined;
    const tab = record.indexOf("\t");
    const [mode, , objectId] = record.slice(0, tab).split(" ");
    return { mode, objectId };
  });
}

export async function materializeTree(root: string, treeHash: string): Promise<{ root: string; dispose: () => Promise<void> }> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "intent-contract-tree-"));
  const indexPath = path.join(temporaryDirectory, "index");
  const checkoutRoot = path.join(temporaryDirectory, "checkout");
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await gitText(root, ["read-tree", treeHash], env);
    await fs.mkdir(checkoutRoot, { recursive: true });
    await gitText(root, ["checkout-index", "--all", "--force", `--prefix=${checkoutRoot}${path.sep}`], env);
  } catch (error) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  return { root: checkoutRoot, dispose: () => fs.rm(temporaryDirectory, { recursive: true, force: true }) };
}

async function applyCandidatePaths(
  root: string,
  baseTree: string,
  rawPaths: string,
  readEntry: (file: string) => Promise<{ mode: string; objectId: string } | undefined>
): Promise<string> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "intent-contract-candidate-"));
  const indexPath = path.join(temporaryDirectory, "index");
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await gitText(root, ["read-tree", baseTree], env);
    const paths = [...new Set(rawPaths.split("\0").filter(Boolean))];
    for (const file of paths) {
      const entry = await readEntry(file);
      if (!entry) {
        await gitText(root, ["update-index", "--force-remove", "--", file], env);
      } else {
        await gitText(root, ["update-index", "--add", "--cacheinfo", entry.mode, entry.objectId, file], env);
      }
    }
    return (await gitText(root, ["write-tree"], env)).trim();
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function shouldTrackIgnoredFile(filePath: string, readOnlyPatterns: string[]): boolean {
  if (highRiskRule(filePath) !== undefined) return true;
  const normalized = filePath.replace(/\\/g, "/");
  if (matchesPatterns(normalized, readOnlyPatterns)) return true;
  if (normalized.startsWith("secrets/") || normalized.includes("secret") || normalized.includes("token")) return true;
  if (normalized.split("/").some((part) => part.startsWith(".env"))) return true;
  return false;
}

export async function captureBaseline(root: string, readOnlyPatterns: string[] = []): Promise<BaselineSnapshot> {
  const baselineTreeHash = await createWorkingTreeSnapshot(root, readOnlyPatterns);
  const startedAt = new Date().toISOString();
  const refName = `refs/intent-contract/baselines/${startedAt.replace(/[^0-9]/g, "")}-${Math.random().toString(16).slice(2, 10)}`;
  await gitText(root, ["update-ref", refName, baselineTreeHash]);
  return {
    baselineTreeHash,
    headSha: await optionalHeadSha(root),
    startedAt,
    baselineRef: refName
  };
}

export async function releaseBaseline(root: string, baselineRef: string | undefined): Promise<void> {
  if (baselineRef && baselineRef.startsWith("refs/intent-contract/baselines/")) {
    try {
      await gitText(root, ["update-ref", "-d", baselineRef]);
    } catch {
      // A missing local baseline ref does not prevent stopping the contract.
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
