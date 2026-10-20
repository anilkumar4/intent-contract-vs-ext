import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadContract } from "../src/contract/loader";
import { createDefaultContract } from "../src/contract/template";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("contract loading", () => {
  it("loads a YAML contract and applies safe defaults", async () => {
    const root = await createTempDirectory();
    const filePath = path.join(root, ".intent", "task.yaml");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "name: task\nintent: Fix the billing issue\nscope:\n  modify: [billing/**]\n");
    await expect(loadContract(filePath)).resolves.toMatchObject({
      name: "task",
      scope: { modify: ["billing/**"], read_only: [] },
      forbid: [],
      allow_exceptions: false
    });
  });

  it("returns readable validation errors", async () => {
    const root = await createTempDirectory();
    const filePath = path.join(root, "invalid.yaml");
    await fs.writeFile(filePath, "intent: Missing name\nscope:\n  modify: []\n");
    await expect(loadContract(filePath)).rejects.toThrow(/Invalid contract.*name/);
  });

  it("creates the default contract and ignores generated session metadata", async () => {
    const root = await createTempDirectory();
    const created = await createDefaultContract(root);
    expect(path.relative(root, created).replace(/\\/g, "/")).toBe(".intent/default.yaml");
    await expect(fs.readFile(created, "utf8")).resolves.toContain("scope:");
    await expect(fs.readFile(path.join(root, ".intent", ".gitignore"), "utf8")).resolves.toContain("waivers.json");
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".intent-contract-contract-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
