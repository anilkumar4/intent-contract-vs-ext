import picomatch from "picomatch";
import type { Contract, Finding, FileChange } from "./types";
import { makeFinding } from "./finding";
import { changedLine, diffEvidence } from "./diffEvidence";

export function detectScope(changes: FileChange[], contract: Contract): Finding[] {
  const findings: Finding[] = [];
  const implicitReadOnly = [
    ".intent/**",
    ...(contract.architecture?.diagram ? [contract.architecture.diagram] : [])
  ];
  for (const change of changes) {
    const paths = change.status === "R"
      ? [change.oldFile, change.newFile].filter((value): value is string => Boolean(value))
      : [change.file];
    for (const file of new Set(paths)) {
      const normalized = file.replace(/\\/g, "/");
      const isImplicitReadOnly = matchesPatterns(normalized, implicitReadOnly);
      const isExplicitReadOnly = matchesPatterns(normalized, contract.scope.read_only);
      if (isImplicitReadOnly || isExplicitReadOnly) {
        findings.push(makeFinding(
          "scope", normalized, "read_only", diffEvidence(change), "error",
          isImplicitReadOnly
            ? `Policy integrity violation: ${normalized} is part of the Intent Contract configuration and cannot be modified during a session`
            : `File is declared read-only by the contract`,
          changedLine(change),
          "Restore this file to the captured baseline or obtain explicit approval to change this read-only path."
        ));
      } else if (!matchesPatterns(normalized, contract.scope.modify)) {
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

export function matchesPatterns(file: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  const normalized = file.replace(/\\/g, "/");
  const positive = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negative = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));

  if (positive.length === 0) return false;

  const matchesPositive = positive.some((pattern) =>
    picomatch.isMatch(normalized, pattern.replace(/\\/g, "/"), { dot: true })
  );
  if (!matchesPositive) return false;

  const matchesNegative = negative.some((pattern) =>
    picomatch.isMatch(normalized, pattern.replace(/\\/g, "/"), { dot: true })
  );
  return !matchesNegative;
}
