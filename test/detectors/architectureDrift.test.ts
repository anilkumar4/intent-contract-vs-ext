import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectArchitectureDrift, renderArchitectureDriftDiagram } from "../../src/detectors/architectureDrift";
import { parseMermaid } from "../../src/architecture/diagramParser";
import type { Contract, ParsedDiff } from "../../src/detectors/types";
import { createWorkingTreeSnapshot } from "../../src/git/snapshot";
import { diffTrees } from "../../src/git/diff";

const repositories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(repositories.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("architecture drift detector", () => {
  it("renders official edges and red dashed violation edges in the export diagram", () => {
    const graph = parseMermaid("flowchart LR\nBilling --> Shared\nInventory --> Shared\n");
    const report = renderArchitectureDriftDiagram(graph, [{
      sourceNode: "Billing", targetNode: "Inventory", sourceFile: "src/billing/invoice.ts",
      targetFile: "src/inventory/stockRepository.ts", line: 12
    }], "docs/system.mmd");
    expect(report).toContain("linkStyle 0 stroke:#4caf50");
    expect(report).toContain(" -.-x |VIOLATION: src/billing/invoice.ts:12 imports src/inventory/stockRepository.ts| ");
    expect(report).toContain("stroke:#e53935");
  });

  it("allows Billing to import Shared when the diagram draws that edge", async () => {
    const { root, policyTree } = await createRepository();
    await fs.writeFile(path.join(root, "src/billing/invoice.ts"), 'import { log } from "../shared/logger";\nexport { log };\n');
    const findings = await detectArchitectureDrift(root, policyTree, await currentDiff(root, policyTree), contract);
    expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("reports an undrawn Billing to Inventory import with the exact line and diagram", async () => {
    const { root, policyTree } = await createRepository();
    await fs.writeFile(path.join(root, "src/billing/invoice.ts"), [
      "export const invoice = 1;",
      'import { stock } from "../inventory/stockRepository";'
    ].join("\n"));
    const findings = await detectArchitectureDrift(root, policyTree, await currentDiff(root, policyTree), contract);
    const error = findings.find((finding) => finding.severity === "error");
    const tick = String.fromCharCode(96);
    expect(error).toMatchObject({
      detector: "architecture_drift",
      severity: "error",
      file: "src/billing/invoice.ts",
      line: 2,
      message: "Architectural Drift: Module " + tick + "Billing" + tick + " (" + tick + "src/billing/invoice.ts" + tick +
        ") imports from " + tick + "Inventory" + tick + " (" + tick + "src/inventory/stockRepository.ts" + tick +
        "), which violates " + tick + "docs/system.mmd" + tick + " (allowed outgoing dependencies from " +
        tick + "Billing" + tick + ": " + tick + "Shared" + tick + ")."
    });
  });

  it("checks existing imports in a modified file instead of only newly added imports", async () => {
    const { root } = await createRepository();
    await fs.writeFile(path.join(root, "src/billing/invoice.ts"), 'import "../inventory/stockRepository";\n');
    git(root, ["add", "src/billing/invoice.ts"]);
    git(root, ["commit", "-m", "add pre-existing boundary import"]);
    const nextPolicy = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
    await fs.appendFile(path.join(root, "src/billing/invoice.ts"), "export const changed = true;\n");
    const findings = await detectArchitectureDrift(root, nextPolicy, await currentDiff(root, nextPolicy), contract);
    expect(findings.some((finding) => finding.rule === "unlisted_edge" && finding.line === 1)).toBe(true);
  });

  it("checks imports when a source file is renamed into a different architecture node", async () => {
    const { root } = await createRepository(
      "flowchart LR\nBilling --> Inventory\nBilling --> Shared\nInventory --> Shared\n"
    );
    await fs.writeFile(path.join(root, "src/billing/invoice.ts"), 'import "../inventory/stockRepository";\n');
    git(root, ["add", "src/billing/invoice.ts"]);
    git(root, ["commit", "-m", "add allowed billing dependency"]);
    const renamePolicy = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
    await fs.mkdir(path.join(root, "src/shared"), { recursive: true });
    await fs.rename(path.join(root, "src/billing/invoice.ts"), path.join(root, "src/shared/invoice.ts"));

    const diff = await currentDiff(root, renamePolicy);
    expect(diff.changes[0]?.status).toBe("R");
    const findings = await detectArchitectureDrift(root, renamePolicy, diff, contract);
    expect(findings).toContainEqual(expect.objectContaining({
      detector: "architecture_drift", severity: "error", file: "src/shared/invoice.ts", line: 1
    }));
  });

  it("resolves tsconfig paths aliases to repository modules", async () => {
    const { root, policyTree } = await createRepository();
    await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        module: "commonjs",
        moduleResolution: "node",
        baseUrl: ".",
        paths: { "@/*": ["src/*"] }
      }
    }));
    await fs.writeFile(path.join(root, "src/billing/invoice.ts"), 'import "@/inventory/stockRepository";\n');
    const findings = await detectArchitectureDrift(root, policyTree, await currentDiff(root, policyTree), contract);
    expect(findings).toContainEqual(expect.objectContaining({
      detector: "architecture_drift", severity: "error", file: "src/billing/invoice.ts", line: 1
    }));
  });

  it("resolves Python package imports to diagram nodes", async () => {
    const { root, policyTree } = await createRepository();
    await fs.writeFile(path.join(root, "src/billing/invoice.py"), [
      "from ..inventory import (",
      "    stockRepository as repository,",
      ")"
    ].join("\n") + "\n");
    await fs.writeFile(path.join(root, "src/inventory/stockRepository.py"), "stock = 1\n");
    const findings = await detectArchitectureDrift(root, policyTree, await currentDiff(root, policyTree), contract);
    expect(findings).toContainEqual(expect.objectContaining({
      detector: "architecture_drift", severity: "error", file: "src/billing/invoice.py", line: 1
    }));
  });

  it("resolves the imported Python submodule rather than an arbitrary package file", async () => {
    const { root, policyTree } = await createRepository(
      "flowchart LR\nBilling --> Shared\nInventory --> Shared\nStock --> Shared\n"
    );
    await fs.writeFile(path.join(root, "src/inventory/aaa.py"), "other = 1\n");
    await fs.writeFile(path.join(root, "src/inventory/stockRepository.py"), "stock = 1\n");
    await fs.writeFile(path.join(root, "src/billing/invoice.py"), "from ..inventory import stockRepository\n");
    const splitModuleContract: Contract = {
      ...contract,
      architecture: {
        ...contract.architecture!,
        node_mappings: {
          Billing: ["src/billing/**"],
          Inventory: ["src/inventory/aaa.py"],
          Stock: ["src/inventory/stockRepository.py"],
          Shared: ["src/shared/**"]
        }
      }
    };
    const findings = await detectArchitectureDrift(
      root, policyTree, await currentDiff(root, policyTree), splitModuleContract
    );
    expect(findings.find((finding) => finding.rule === "unlisted_edge")?.message).toContain("Stock");
  });

  it("resolves Go module imports to diagram nodes", async () => {
    const { root, policyTree } = await createRepository();
    await fs.writeFile(path.join(root, "go.mod"), "module example.com/app\n");
    await fs.writeFile(path.join(root, "src/billing/invoice.go"), [
      "package billing",
      "import \"example.com/app/src/inventory\"",
      "func Invoice() {}"
    ].join("\n"));
    await fs.writeFile(path.join(root, "src/inventory/repository.go"), "package inventory\n");
    const findings = await detectArchitectureDrift(root, policyTree, await currentDiff(root, policyTree), contract);
    expect(findings).toContainEqual(expect.objectContaining({
      detector: "architecture_drift", severity: "error", file: "src/billing/invoice.go", line: 2
    }));
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

async function createRepository(diagram = "flowchart LR\nBilling --> Shared\nInventory --> Shared\n"): Promise<{ root: string; policyTree: string }> {
  vi.spyOn(os, "tmpdir").mockReturnValue(process.cwd());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-architecture-test-"));
  repositories.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Intent Contract Test"]);
  git(root, ["config", "user.email", "intent-test@example.invalid"]);
  for (const directory of ["docs", "src/billing", "src/inventory", "src/shared"]) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  await fs.writeFile(path.join(root, "docs/system.mmd"), diagram);
  await fs.writeFile(path.join(root, "tsconfig.json"), '{"compilerOptions":{"module":"commonjs","moduleResolution":"node"}}\n');
  await fs.writeFile(path.join(root, "src/billing/invoice.ts"), "export const invoice = 1;\n");
  await fs.writeFile(path.join(root, "src/inventory/stockRepository.ts"), "export const stock = 1;\n");
  await fs.writeFile(path.join(root, "src/shared/logger.ts"), "export const log = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "baseline"]);
  return { root, policyTree: git(root, ["rev-parse", "HEAD^{tree}"]).trim() };
}

async function currentDiff(root: string, baseTree: string): Promise<ParsedDiff> {
  return diffTrees(root, baseTree, await createWorkingTreeSnapshot(root));
}
function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
}
