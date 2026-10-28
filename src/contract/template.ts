import fs from "node:fs/promises";
import path from "node:path";

export const defaultContractTemplate = `name: default
intent: Describe the change this task is meant to make
scope:
  modify:
    - "src/**"
  read_only: []
forbid:
  - new_dependencies
  - high_risk_files
allow_exceptions: true
`;

export async function createDefaultContract(root: string): Promise<string> {
  const directory = path.join(root, ".intent");
  await fs.mkdir(directory, { recursive: true });
  const contractPath = path.join(directory, "default.yaml");
  try {
    await fs.access(contractPath);
    throw new Error(".intent/default.yaml already exists; it was left unchanged.");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await fs.writeFile(contractPath, defaultContractTemplate, { encoding: "utf8", flag: "wx" });
  await ensureIntentMetadataIgnored(root);
  return contractPath;
}

export async function ensureIntentMetadataIgnored(root: string): Promise<void> {
  const directory = path.join(root, ".intent");
  await fs.mkdir(directory, { recursive: true });
  const ignorePath = path.join(directory, ".gitignore");
  let contents = "";
  try {
    contents = await fs.readFile(ignorePath, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const lines = new Set(contents.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const required = [".state.json", ".violations.md", "waivers.json", ".architecture-drift.mmd", "reports/"];
  const missing = required.filter((line) => !lines.has(line));
  if (missing.length > 0) {
    const separator = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
    await fs.writeFile(ignorePath, `${contents}${separator}${missing.join("\n")}\n`, "utf8");
  } else if (!contents) {
    await fs.writeFile(ignorePath, `${required.join("\n")}\n`, "utf8");
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
