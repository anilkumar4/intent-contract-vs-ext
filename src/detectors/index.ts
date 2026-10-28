import type { Contract, Finding, ParsedDiff } from "./types";
import { detectDependencies } from "./dependencies";
import { detectHighRiskFiles } from "./highRisk";
import { detectScope } from "./scope";
import { detectSymbolScope } from "./symbolScope";
import { detectTautologicalTests } from "./tautologicalTests";
import { detectTestWeakening } from "./testWeakening";
import { detectArchitectureDrift } from "./architectureDrift";

export function detectFindings(diff: ParsedDiff, contract: Contract): Finding[] {
  return [
    ...detectScope(diff.changes, contract),
    ...detectSymbolScope(diff.changes, contract),
    ...detectDependencies(diff.changes, contract),
    ...detectHighRiskFiles(diff.changes, contract),
    ...(contract.forbid.includes("test_weakening") ? [
      ...detectTestWeakening(diff.changes),
      ...detectTautologicalTests(diff.changes)
    ] : [])
  ].sort((a, b) => a.file.localeCompare(b.file) || a.detector.localeCompare(b.detector) || a.id.localeCompare(b.id));
}

export async function detectFindingsForWorkspace(
  root: string,
  policyTree: string,
  diff: ParsedDiff,
  contract: Contract,
  contractFile?: string,
  resolutionRoot = root
): Promise<Finding[]> {
  const findings = [
    ...detectFindings(diff, contract),
    ...await detectArchitectureDrift(root, policyTree, diff, contract, contractFile, resolutionRoot)
  ];
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()]
    .sort((a, b) => a.file.localeCompare(b.file) || a.detector.localeCompare(b.detector) || a.id.localeCompare(b.id));
}
