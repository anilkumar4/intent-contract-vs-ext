import fs from "node:fs/promises";
import path from "node:path";
import type { Finding } from "../detectors/types";
import type { Waiver } from "./waivers";

export async function writeViolationSummary(root: string, findings: Finding[], waivers: Map<string, Waiver>): Promise<void> {
  const active = findings.filter((finding) => !waivers.has(finding.id));
  const lines = ["# Intent Contract findings", ""];
  if (active.length === 0) {
    lines.push("No active violations were detected.");
  } else {
    lines.push("Please correct these detected changes or discuss an exception with the developer:", "");
    for (const finding of active) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      lines.push(`- [${finding.severity.toUpperCase()}] ${location} — ${finding.message}. Evidence: ${finding.evidence}`);
    }
  }
  const directory = path.join(root, ".intent");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, ".violations.md"), `${lines.join("\n")}\n`, "utf8");
}
