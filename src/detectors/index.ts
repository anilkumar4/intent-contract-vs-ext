import type { Contract, Finding, ParsedDiff } from "./types";
import { detectDependencies } from "./dependencies";
import { detectHighRiskFiles } from "./highRisk";
import { detectScope } from "./scope";

export function detectFindings(diff: ParsedDiff, contract: Contract): Finding[] {
  return [
    ...detectScope(diff.changes, contract),
    ...detectDependencies(diff.changes, contract),
    ...detectHighRiskFiles(diff.changes, contract)
  ].sort((a, b) => a.file.localeCompare(b.file) || a.detector.localeCompare(b.detector) || a.id.localeCompare(b.id));
}
