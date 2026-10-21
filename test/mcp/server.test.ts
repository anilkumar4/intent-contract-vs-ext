import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRpcMessage } from "../../src/mcp/server";
import { startIntentContract } from "../../src/runtime/contracts";

const temporaryRepositories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRepositories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("MCP stdio JSON-RPC protocol", () => {
  it("lists tools, verifies violations, and reverts scope violations without touching the index", async () => {
    const root = await createRepository();
    await startIntentContract(root, "test");

    await fs.writeFile(path.join(root, "src/app.ts"), "export const app = 2;\n");
    git(root, ["add", "src/app.ts"]);
    const stagedBefore = git(root, ["diff", "--cached", "--binary"]);
    await fs.writeFile(path.join(root, "test/locked.txt"), "changed outside the contract\n");

    const listed = JSON.parse((await handleRpcMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), root)) ?? "{}") as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual([
      "get_active_contract",
      "verify_intent_contract",
      "revert_out_of_scope_files",
      "start_intent_contract"
    ]);

    const active = JSON.parse((await handleRpcMessage(JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_active_contract", arguments: {} }
    }), root)) ?? "{}") as { result: { structuredContent: { name: string; read_only: string[] } } };
    expect(active.result.structuredContent.name).toBe("test");
    expect(active.result.structuredContent.read_only).toEqual(["test/**"]);

    const verification = JSON.parse((await handleRpcMessage(JSON.stringify({
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "verify_intent_contract", arguments: {} }
    }), root)) ?? "{}") as { result: { structuredContent: { passed: boolean; errorCount: number; findings: Array<{ file: string }> } } };
    expect(verification.result.structuredContent).toMatchObject({ passed: false, errorCount: 1 });
    expect(verification.result.structuredContent.findings).toContainEqual(expect.objectContaining({ file: "test/locked.txt" }));

    const reverted = JSON.parse((await handleRpcMessage(JSON.stringify({
      jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "revert_out_of_scope_files", arguments: {} }
    }), root)) ?? "{}") as { result: { structuredContent: { reverted: string[] } } };
    expect(reverted.result.structuredContent.reverted).toEqual(["test/locked.txt"]);
    expect(await fs.readFile(path.join(root, "test/locked.txt"), "utf8")).toBe("baseline\n");
    expect(git(root, ["diff", "--cached", "--binary"])).toBe(stagedBefore);
  }, 30_000);

  it("enforces architecture_drift through verify_intent_contract", async () => {
    const root = await createArchitectureRepository();
    await startIntentContract(root, "architecture");
    await fs.writeFile(path.join(root, "src/billing/invoice.ts"), 'import "../inventory/db";\n');

    const verification = JSON.parse((await handleRpcMessage(JSON.stringify({
      jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "verify_intent_contract", arguments: {} }
    }), root)) ?? "{}") as {
      result: { structuredContent: { passed: boolean; errorCount: number; findings: Array<{ detector: string; file: string }> } };
    };
    expect(verification.result.structuredContent).toMatchObject({
      passed: false,
      errorCount: 1,
      findings: [expect.objectContaining({ detector: "architecture_drift", file: "src/billing/invoice.ts" })]
    });
  }, 30_000);
});

async function createRepository(): Promise<string> {
  vi.spyOn(os, "tmpdir").mockReturnValue(process.cwd());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-mcp-test-"));
  temporaryRepositories.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Intent Contract Test"]);
  git(root, ["config", "user.email", "intent-test@example.invalid"]);
  await fs.mkdir(path.join(root, ".intent"), { recursive: true });
  await fs.mkdir(path.join(root, "test"), { recursive: true });
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, ".intent/test.yaml"), [
    "name: test",
    "intent: Test the MCP server",
    "scope:",
    "  modify: [src/**]",
    "  read_only: [test/**]",
    "forbid: []",
    "allow_exceptions: false"
  ].join("\n") + "\n");
  await fs.writeFile(path.join(root, "test/locked.txt"), "baseline\n");
  await fs.writeFile(path.join(root, "src/app.ts"), "export const app = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "baseline"]);
  return root;
}

async function createArchitectureRepository(): Promise<string> {
  vi.spyOn(os, "tmpdir").mockReturnValue(process.cwd());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-mcp-architecture-test-"));
  temporaryRepositories.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Intent Contract Test"]);
  git(root, ["config", "user.email", "intent-test@example.invalid"]);
  for (const directory of [".intent", "docs", "src/billing", "src/inventory", "src/shared"]) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  await fs.writeFile(path.join(root, ".intent/architecture.yaml"), [
    "name: architecture",
    "intent: Keep architecture boundaries",
    "scope:",
    "  modify: [\"src/**\"]",
    "architecture:",
    "  diagram: docs/system.mmd",
    "  node_mappings:",
    "    Billing: [\"src/billing/**\"]",
    "    Inventory: [\"src/inventory/**\"]",
    "    Shared: [\"src/shared/**\"]",
    "  default_policy: deny_unlisted_edges",
    "forbid: [architecture_drift]",
    "allow_exceptions: false"
  ].join("\n") + "\n");
  await fs.writeFile(path.join(root, "docs/system.mmd"), "flowchart LR\nBilling --> Shared\nInventory --> Shared\n");
  await fs.writeFile(path.join(root, "src/billing/invoice.ts"), "export const invoice = 1;\n");
  await fs.writeFile(path.join(root, "src/inventory/db.ts"), "export const db = 1;\n");
  await fs.writeFile(path.join(root, "src/shared/logger.ts"), "export const log = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "architecture baseline"]);
  return root;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
}
