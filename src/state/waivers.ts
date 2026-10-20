import fs from "node:fs/promises";
import path from "node:path";

export interface Waiver {
  id: string;
  reason: string;
  timestamp: string;
}

export async function readWaivers(root: string): Promise<Map<string, Waiver>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(waiverPath(root), "utf8"));
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
  return typeof candidate.id === "string" && typeof candidate.reason === "string" && typeof candidate.timestamp === "string";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
