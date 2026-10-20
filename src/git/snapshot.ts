import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitText, optionalHeadSha } from "./cli";

export interface BaselineSnapshot {
  baselineTreeHash: string;
  headSha: string | null;
  startedAt: string;
  baselineRef: string;
}

export async function createWorkingTreeSnapshot(root: string): Promise<string> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "intent-contract-index-"));
  const temporaryIndexPath = path.join(temporaryDirectory, "index");
  const indexPath = (await gitText(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
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
    await gitText(root, ["rm", "--cached", "--ignore-unmatch", "--", ".intent/.state.json", ".intent/.violations.md", ".intent/waivers.json"], env);
    return (await gitText(root, ["write-tree"], env)).trim();
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function captureBaseline(root: string): Promise<BaselineSnapshot> {
  const baselineTreeHash = await createWorkingTreeSnapshot(root);
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
