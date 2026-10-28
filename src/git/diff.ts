import { gitBuffer, gitText } from "./cli";
import type { ChangeStatus, DiffHunk, DiffHunkLine, DiffLine, FileChange, ParsedDiff } from "../detectors/types";
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
    } else if (status === "A") {
      const file = toRepoPath(fields[index++] ?? "");
      entries.push({ status, file, newFile: file });
    } else if (status === "D") {
      const file = toRepoPath(fields[index++] ?? "");
      entries.push({ status, file, oldFile: file });
    } else {
      const file = toRepoPath(fields[index++] ?? "");
      entries.push({ status, file, oldFile: file, newFile: file });
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
    const { additions, deletions, hunks, binary } = parseSection(section);
    return {
      ...entry,
      additions,
      deletions,
      hunks,
      binary
    };
  });
  return { changes };
}

export async function diffTrees(root: string, baselineTreeHash: string, currentTreeHash: string): Promise<ParsedDiff> {
  if (baselineTreeHash === currentTreeHash) {
    return { changes: [] };
  }
  const [nameStatusOutput, patch] = await Promise.all([
    gitText(root, [
      "diff-tree", "-r", "-M", "--no-commit-id", "-z", "--name-status", baselineTreeHash, currentTreeHash
    ]),
    gitText(root, [
      "diff", "-M", "-U3", "--no-ext-diff", "--no-textconv", "--no-color", baselineTreeHash, currentTreeHash, "--"
    ])
  ]);
  const parsed = parseUnifiedDiff(nameStatusOutput, patch);
  await Promise.all(parsed.changes.map(async (change) => {
    if (change.binary) return;
    const tasks: Promise<void>[] = [];
    if (change.oldFile && change.status !== "A" && change.status !== "C") {
      tasks.push(readTreeText(root, baselineTreeHash, change.oldFile).then((text) => {
        change.beforeContent = text;
      }));
    }
    if (change.newFile && change.status !== "D") {
      tasks.push(readTreeText(root, currentTreeHash, change.newFile).then((text) => {
        change.afterContent = text;
      }));
    }
    await Promise.all(tasks);
  }));
  return parsed;
}

async function readTreeText(root: string, treeHash: string, repoPath: string): Promise<string | undefined> {
  try {
    const objectId = `${treeHash}:${repoPath}`;
    const buffer = await gitBuffer(root, ["cat-file", "blob", objectId]);
    if (buffer.length > 2 * 1024 * 1024 || buffer.includes(0)) return undefined;
    return buffer.toString("utf8");
  } catch {
    return undefined;
  }
}

function parseSection(section: string): { additions: DiffLine[]; deletions: DiffLine[]; hunks: DiffHunk[]; binary: boolean } {
  const additions: DiffLine[] = [];
  const deletions: DiffLine[] = [];
  const hunks: DiffHunk[] = [];
  const lines = section.split(/\r?\n/);
  const binary = lines.some((line) => line.startsWith("Binary files ") || line === "GIT binary patch");
  let oldLine = 0;
  let newLine = 0;
  let currentHunk: DiffHunk | undefined;
  for (const line of lines) {
    const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkHeader) {
      oldLine = Number(hunkHeader[1]);
      newLine = Number(hunkHeader[2]);
      currentHunk = { oldStart: oldLine, newStart: newLine, lines: [] };
      hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      const hunkLine: DiffHunkLine = { kind: "add", text: line.slice(1), oldLine, newLine };
      currentHunk.lines.push(hunkLine);
      additions.push({ kind: "add", text: hunkLine.text, oldLine, newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      const hunkLine: DiffHunkLine = { kind: "delete", text: line.slice(1), oldLine, newLine };
      currentHunk.lines.push(hunkLine);
      deletions.push({ kind: "delete", text: hunkLine.text, oldLine, newLine });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ kind: "context", text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return { additions, deletions, hunks, binary };
}
