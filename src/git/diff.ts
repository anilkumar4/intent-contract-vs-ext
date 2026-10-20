import { gitBuffer, gitText } from "./cli";
import type { ChangeStatus, DiffLine, FileChange, ParsedDiff } from "../detectors/types";
import { toRepoPath } from "../util/paths";

interface NameStatusEntry {
  status: ChangeStatus;
  file: string;
  oldFile?: string;
  newFile?: string;
}

export function parseNameStatus(output: string): NameStatusEntry[] {
  const fields = output.split("\0");
  const entries: NameStatusEntry[] = [];
  let index = 0;
  while (index < fields.length) {
    const statusText = fields[index++];
    if (!statusText) continue;
    const status = statusText[0] as ChangeStatus;
    if (status === "R" || status === "C") {
      const oldFile = toRepoPath(fields[index++] ?? "");
      const newFile = toRepoPath(fields[index++] ?? "");
      entries.push({ status, file: newFile, oldFile, newFile });
    } else {
      const file = toRepoPath(fields[index++] ?? "");
      entries.push({ status, file, ...(status === "D" ? { oldFile: file } : { newFile: file }) });
    }
  }
  return entries;
}

export function parseUnifiedDiff(nameStatusOutput: string, patch: string): ParsedDiff {
  const entries = parseNameStatus(nameStatusOutput);
  const sections = patch
    .split(/(?=^diff --git )/m)
    .filter((section) => section.startsWith("diff --git "));
  const changes = entries.map((entry, entryIndex): FileChange => {
    const section = sections[entryIndex] ?? "";
    const { additions, deletions, binary } = parseSection(section);
    return {
      ...entry,
      additions,
      deletions,
      binary
    };
  });
  return { changes };
}

export async function diffTrees(root: string, baselineTreeHash: string, currentTreeHash: string): Promise<ParsedDiff> {
  const nameStatusOutput = await gitText(root, [
    "diff-tree", "-r", "-M", "--no-commit-id", "-z", "--name-status", baselineTreeHash, currentTreeHash
  ]);
  const patch = await gitText(root, [
    "diff", "-M", "-U3", "--no-ext-diff", "--no-textconv", "--no-color", baselineTreeHash, currentTreeHash, "--"
  ]);
  const parsed = parseUnifiedDiff(nameStatusOutput, patch);
  for (const change of parsed.changes) {
    if (change.binary) continue;
    if (change.oldFile && change.status !== "A" && change.status !== "C") {
      change.beforeContent = await readTreeText(root, baselineTreeHash, change.oldFile);
    }
    if (change.newFile && change.status !== "D") {
      change.afterContent = await readTreeText(root, currentTreeHash, change.newFile);
    }
  }
  return parsed;
}

async function readTreeText(root: string, treeHash: string, repoPath: string): Promise<string | undefined> {
  try {
    const objectId = `${treeHash}:${repoPath}`;
    const size = Number((await gitText(root, ["cat-file", "-s", objectId])).trim());
    if (!Number.isFinite(size) || size > 2 * 1024 * 1024) return undefined;
    const buffer = await gitBuffer(root, ["cat-file", "blob", objectId]);
    if (buffer.includes(0)) return undefined;
    return buffer.toString("utf8");
  } catch {
    return undefined;
  }
}

function parseSection(section: string): { additions: DiffLine[]; deletions: DiffLine[]; binary: boolean } {
  const additions: DiffLine[] = [];
  const deletions: DiffLine[] = [];
  const lines = section.split(/\r?\n/);
  const binary = lines.some((line) => line.startsWith("Binary files ") || line === "GIT binary patch");
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("\\")) continue;
    if (line.startsWith("+") && inHunk) {
      additions.push({ kind: "add", text: line.slice(1), newLine });
      newLine += 1;
    } else if (line.startsWith("-") && inHunk) {
      deletions.push({ kind: "delete", text: line.slice(1), oldLine });
      oldLine += 1;
    } else if (line.startsWith(" ") && inHunk) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return { additions, deletions, binary };
}
