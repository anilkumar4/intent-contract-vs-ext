import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectArchitectureDrift } from "../../src/detectors/architecture";
import type { Contract, ParsedDiff } from "../../src/detectors/types";
import { createWorkingTreeSnapshot } from "../../src/git/snapshot";
import { diffTrees } from "../../src/git/diff";

const temporaryRepositories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRepositories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("architecture drift detector", () => {
  it("allows a new import when the diagram has the directed module edge", async () => {
    const { root, policyTree } = await createRepository("flowchart LR\nBilling --> Shared\nInventory\n");
    await fs.writeFile(path.join(root, "src/billing/invoice.ts"), 'import { date } from "../shared/date";\nexport { date };\n');
    const diff = await currentDiff(root, policyTree);
    const findings = await detectArchitectureDrift(root, policyTree, diff, contract);
    expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("reports a newly introduced import whose module edge is not drawn", async () => {
    const { root, policyTree } = await createRepository("flowchart LR\nBilling --> Shared\nInventory\n");
    await fs.writeFile(path.join(root, "src/billing/invoice.ts"), 'import { client } from "../inventory/client";\nexport { client };\n');
    const diff = await currentDiff(root, policyTree);
    const findings = await detectArchitectureDrift(root, policyTree, diff, contract);
    expect(findings).toMatchObject([
      { detector: "architecture_drift", severity: "error", file: "src/billing/invoice.ts", rule: "unlisted_edge" }
    ]);
  });
});

const contract: Contract = {
  name: "architecture",
  intent: "Keep module edges explicit",
  scope: { modify: ["src/**"], read_only: [] },
  architecture: {
    diagram: "docs/system.mmd",
    node_mappings: {
      Billing: ["src/billing/**"],
      Inventory: ["src/inventory/**"],
      Shared: ["src/shared/**"]
    },
    default_policy: "deny_unlisted_edges"
  },
  forbid: ["architecture_drift"],
  allow_exceptions: false
};

async function createRepository(diagram: string): Promise<{ root: string; policyTree: string }> {
  vi.spyOn(os, "tmpdir").mockReturnValue(process.cwd());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-architecture-test-"));
  temporaryRepositories.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Intent Contract Test"]);
  git(root, ["config", "user.email", "intent-test@example.invalid"]);
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.mkdir(path.join(root, "src/billing"), { recursive: true });
  await fs.mkdir(path.join(root, "src/inventory"), { recursive: true });
  await fs.mkdir(path.join(root, "src/shared"), { recursive: true });
  await fs.writeFile(path.join(root, "docs/system.mmd"), diagram);
  await fs.writeFile(path.join(root, "tsconfig.json"), '{"compilerOptions":{"module":"commonjs","moduleResolution":"node"}}\n');
  await fs.writeFile(path.join(root, "src/billing/invoice.ts"), "export const invoice = 1;\n");
  await fs.writeFile(path.join(root, "src/inventory/client.ts"), "export const client = 1;\n");
  await fs.writeFile(path.join(root, "src/shared/date.ts"), "export const date = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "baseline"]);
  return { root, policyTree: git(root, ["rev-parse", "HEAD^{tree}"]).trim() };
}

async function currentDiff(root: string, policyTree: string): Promise<ParsedDiff> {
  return diffTrees(root, policyTree, await createWorkingTreeSnapshot(root));
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
}
