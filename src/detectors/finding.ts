import { createHash } from "node:crypto";
import type { DetectorId, Finding, Severity } from "./types";

export function makeFinding(
  detector: DetectorId,
  file: string,
  rule: string,
  evidence: string,
  severity: Severity,
  message: string,
  line?: number
): Finding {
  const normalizedFile = file.replace(/\\/g, "/");
  const id = createHash("sha256")
    .update(JSON.stringify([detector, normalizedFile, rule, evidence]))
    .digest("hex")
    .slice(0, 24);
  return {
    id,
    detector,
    severity,
    file: normalizedFile,
    ...(line === undefined ? {} : { line }),
    message,
    evidence
  };
}
