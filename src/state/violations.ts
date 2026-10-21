import fs from "node:fs/promises";
import path from "node:path";
import type { Finding } from "../detectors/types";
import type { Waiver } from "./waivers";
import { formatFindingsForAgent } from "./formatViolations";

export async function writeViolationSummary(root: string, findings: Finding[], waivers: Map<string, Waiver>): Promise<void> {
  const active = findings.filter((finding) => !waivers.has(finding.id));
  const directory = path.join(root, ".intent");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, ".violations.md"), `# Intent Contract findings\n\n${formatFindingsForAgent(active)}\n`, "utf8");
}
