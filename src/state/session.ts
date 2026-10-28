import fs from "node:fs/promises";
import path from "node:path";
import type { BaselineSnapshot } from "../git/snapshot";

export interface ContractSession extends BaselineSnapshot {
  activeContract: string;
  originalBaselineTreeHash?: string;
}

export async function readSession(root: string): Promise<ContractSession | undefined> {
  try {
    const raw = await fs.readFile(sessionPath(root), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isContractSession(parsed)) return undefined;
    return parsed;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function writeSession(root: string, session: ContractSession): Promise<void> {
  const directory = path.join(root, ".intent");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(sessionPath(root), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export async function removeSession(root: string): Promise<void> {
  try {
    await fs.unlink(sessionPath(root));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function sessionPath(root: string): string {
  return path.join(root, ".intent", ".state.json");
}

function isContractSession(value: unknown): value is ContractSession {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Record<string, unknown>;
  return typeof session.activeContract === "string" &&
    typeof session.baselineTreeHash === "string" &&
    (typeof session.headSha === "string" || session.headSha === null) &&
    typeof session.startedAt === "string" &&
    (typeof session.baselineRef === "string" || session.baselineRef === undefined) &&
    (typeof session.originalBaselineTreeHash === "string" || session.originalBaselineTreeHash === undefined);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
