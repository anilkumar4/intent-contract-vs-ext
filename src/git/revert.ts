import fs from "node:fs/promises";
import path from "node:path";
import { gitBuffer, gitText } from "./cli";
import type { FileChange } from "../detectors/types";
import { resolveRepoFile } from "../util/paths";

export async function revertFileToBaseline(root: string, baselineTreeHash: string, change: FileChange): Promise<void> {
  if (change.status === "R") {
    if (!change.oldFile || !change.newFile) throw new Error("Rename change is missing a path.");
    const newPath = resolveRepoFile(root, change.newFile);
    await assertSafeParentDirectories(root, path.dirname(newPath));
    await removeIfPresent(newPath);
    await restoreBaselinePath(root, baselineTreeHash, change.oldFile);
    return;
  }
  if (change.status === "A" || change.status === "C") {
    const addedPath = resolveRepoFile(root, change.file);
    await assertSafeParentDirectories(root, path.dirname(addedPath));
    await removeIfPresent(addedPath);
    return;
  }
  const baselinePath = change.oldFile ?? change.file;
  await restoreBaselinePath(root, baselineTreeHash, baselinePath);
}

async function restoreBaselinePath(root: string, baselineTreeHash: string, repoPath: string): Promise<void> {
  const absolutePath = resolveRepoFile(root, repoPath);
  const content = await gitBuffer(root, ["cat-file", "blob", `${baselineTreeHash}:${repoPath}`]);
  const treeEntry = await gitText(root, ["ls-tree", baselineTreeHash, "--", repoPath]);
  const isBaselineSymlink = /^120000 blob /.test(treeEntry);
  await ensureSafeParentDirectories(root, path.dirname(absolutePath));

  const existing = await lstatIfPresent(absolutePath);
  if (existing?.isDirectory()) throw new Error(`Cannot restore ${repoPath}: a directory currently occupies the file path.`);
  if (existing && (existing.isSymbolicLink() || isBaselineSymlink)) await fs.unlink(absolutePath);

  if (isBaselineSymlink) {
    await fs.symlink(content.toString("utf8"), absolutePath, "file");
  } else {
    await fs.writeFile(absolutePath, content);
  }
}

async function ensureSafeParentDirectories(root: string, directory: string): Promise<void> {
  const relative = path.relative(root, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Cannot restore a file outside the Git repository.");
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatIfPresent(current);
    if (stat?.isSymbolicLink()) throw new Error(`Cannot restore through a symbolic link: ${current}`);
    if (stat && !stat.isDirectory()) throw new Error(`Cannot restore through a non-directory path: ${current}`);
    if (!stat) await fs.mkdir(current);
  }
}

async function assertSafeParentDirectories(root: string, directory: string): Promise<void> {
  const relative = path.relative(root, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Cannot restore a file outside the Git repository.");
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatIfPresent(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`Cannot restore through a symbolic link: ${current}`);
    if (!stat.isDirectory()) return;
  }
}

async function lstatIfPresent(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
