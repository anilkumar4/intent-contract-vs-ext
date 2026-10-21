import type { FileChange } from "./types";

export function diffEvidence(change: FileChange, preferredText?: string): string {
  const changed = [...change.deletions, ...change.additions];
  const matching = preferredText
    ? changed.filter((line) => line.text.includes(preferredText))
    : [];
  const selected = matching.length > 0 ? matching : changed;
  const snippet = selected.slice(0, 6).map((line) => {
    const number = line.kind === "delete" ? line.oldLine : line.newLine;
    const location = number === undefined ? "" : ` ${number}:`;
    return `${line.kind === "add" ? "+" : "-"}${location} ${line.text}`;
  });
  return snippet.length > 0 ? snippet.join("\n") : `File status: ${change.status}`;
}

export function changedLine(change: FileChange, preferredText?: string): number | undefined {
  const candidates = [...change.additions, ...change.deletions];
  const selected = preferredText ? candidates.find((line) => line.text.includes(preferredText)) : undefined;
  const line = selected ?? candidates[0];
  return line?.kind === "delete" ? line.oldLine : line?.newLine;
}
