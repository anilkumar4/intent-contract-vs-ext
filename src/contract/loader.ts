import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { contractSchema, type Contract } from "./schema";

export async function loadContract(filePath: string): Promise<Contract> {
  const source = await fs.readFile(filePath, "utf8");
  return parseContract(source, path.basename(filePath));
}

export function parseContract(source: string, fileName = "contract.yaml"): Contract {
  let value: unknown;
  try {
    value = parse(source);
  } catch (error) {
    throw new Error(`Invalid YAML in ${fileName}: ${errorMessage(error)}`);
  }
  const result = contractSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "contract"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid contract in ${fileName}: ${details}`);
  }
  return result.data;
}

export async function discoverContracts(root: string): Promise<string[]> {
  const directory = path.join(root, ".intent");
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
