import picomatch from "picomatch";
import type { Contract, Finding, FileChange } from "./types";
import { makeFinding } from "./finding";

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
          "scope", normalized, "read_only", "read_only path changed", "error",
          `File is declared read-only by the contract`
        ));
      } else if (!matchesAny(normalized, contract.scope.modify)) {
        findings.push(makeFinding(
          "scope", normalized, "outside_modify", "path is outside scope.modify", "warning",
          `File is outside the permitted modify scope`
        ));
      }
    }
  }
  return findings;
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => picomatch.isMatch(file, pattern.replace(/\\/g, "/"), { dot: true }));
}
