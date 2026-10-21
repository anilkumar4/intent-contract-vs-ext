import picomatch from "picomatch";
import type { Contract, Finding, FileChange } from "./types";
import { makeFinding } from "./finding";
import { changedLine, diffEvidence } from "./diffEvidence";

export function detectScope(changes: FileChange[], contract: Contract): Finding[] {
  const findings: Finding[] = [];
  for (const change of changes) {
    const paths = change.status === "R"
      ? [change.oldFile, change.newFile].filter((value): value is string => Boolean(value))
      : [change.file];
    for (const file of new Set(paths)) {
      const normalized = file.replace(/\\/g, "/");
      if (matchesAny(normalized, contract.scope.read_only)) {
        findings.push(makeFinding(
          "scope", normalized, "read_only", diffEvidence(change), "error",
          `File is declared read-only by the contract`,
          changedLine(change),
          "Restore this file to the captured baseline or obtain explicit approval to change this read-only path."
        ));
      } else if (!matchesAny(normalized, contract.scope.modify)) {
        findings.push(makeFinding(
          "scope", normalized, "outside_modify", diffEvidence(change), "warning",
          `File is outside the permitted modify scope`,
          changedLine(change),
          "Move the change into scope.modify or obtain explicit approval to expand the contract scope."
        ));
      }
    }
  }
  return findings;
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => picomatch.isMatch(file, pattern.replace(/\\/g, "/"), { dot: true }));
}
