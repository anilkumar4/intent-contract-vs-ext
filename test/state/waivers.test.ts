import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWaivers, addWaiver } from "../../src/state/waivers";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  );
});

describe("waivers management", () => {
  it("rejects malformed waivers.json and names the file in the error", async () => {
    const root = await createTempDir();
    const intentDir = path.join(root, ".intent");
    await fs.mkdir(intentDir, { recursive: true });
    await fs.writeFile(path.join(intentDir, "waivers.json"), "{ invalid json ");

    await expect(readWaivers(root)).rejects.toThrow(/\.intent\/waivers\.json/);
  });

  it("rejects waivers with empty reasons or invalid timestamps", async () => {
    const root = await createTempDir();
    const intentDir = path.join(root, ".intent");
    await fs.mkdir(intentDir, { recursive: true });
    await fs.writeFile(
      path.join(intentDir, "waivers.json"),
      JSON.stringify([
        { id: "5d75480e6ec686340f9a3cff", reason: "", timestamp: "not-a-date" },
        { id: "valid-1", reason: "Approved migration", timestamp: new Date().toISOString() }
      ])
    );

    const waivers = await readWaivers(root);
    expect(waivers.has("5d75480e6ec686340f9a3cff")).toBe(false);
    expect(waivers.has("valid-1")).toBe(true);
  });

  it("adds and reads valid waivers", async () => {
    const root = await createTempDir();
    await addWaiver(root, {
      id: "test-finding-1",
      reason: "Explicit user approval",
      timestamp: new Date().toISOString()
    });

    const waivers = await readWaivers(root);
    expect(waivers.get("test-finding-1")?.reason).toBe("Explicit user approval");
  });
});

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-waiver-test-"));
  temporaryDirectories.push(dir);
  return dir;
}

