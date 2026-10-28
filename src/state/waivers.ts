import fs from "node:fs/promises";
import path from "node:path";

export interface Waiver {
  id: string;
  reason: string;
  timestamp: string;
}

export async function readWaivers(root: string): Promise<Map<string, Waiver>> {
  const filePath = waiverPath(root);
  try {
    const content = await fs.readFile(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (parseError) {
      throw new Error(`Failed to parse .intent/waivers.json: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    }
    if (!Array.isArray(parsed)) return new Map();
    const waivers = new Map<string, Waiver>();
    for (const item of parsed) {
      if (isWaiver(item)) waivers.set(item.id, item);
    }
    return waivers;
  } catch (error) {
    if (isMissing(error)) return new Map();
    throw error;
  }
}

export async function readWaiversForContract(root: string, allowExceptions: boolean): Promise<Map<string, Waiver>> {
  return allowExceptions ? readWaivers(root) : new Map();
}

export async function addWaiver(root: string, waiver: Waiver): Promise<void> {
  const waivers = await readWaivers(root);
  waivers.set(waiver.id, waiver);
  await fs.mkdir(path.dirname(waiverPath(root)), { recursive: true });
  await fs.writeFile(waiverPath(root), `${JSON.stringify([...waivers.values()].sort((a, b) => a.id.localeCompare(b.id)), null, 2)}\n`, "utf8");
}

function waiverPath(root: string): string {
  return path.join(root, ".intent", "waivers.json");
}

function isWaiver(value: unknown): value is Waiver {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.trim().length > 0 &&
    typeof candidate.reason === "string" &&
    candidate.reason.trim().length > 0 &&
    typeof candidate.timestamp === "string" &&
    !Number.isNaN(Date.parse(candidate.timestamp))
  );
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
