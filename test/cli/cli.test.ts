import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli";

const temporaryRepositories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRepositories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("headless CLI", () => {
  it("checks a base ref and emits GitHub annotations with correct exit codes", async () => {
    const root = await createRepository();
    await fs.writeFile(path.join(root, "README.md"), "second commit\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "second"]);
    await fs.writeFile(path.join(root, "package.json"), '{"name":"sample","dependencies":{"unexpected-package":"1.0.0"}}\n');

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);
    const failed = await runCli(["check", "--base", "HEAD~1", "--contract", ".intent/test.yaml", "--format", "github"], root);
    expect(failed).toBe(1);
    expect(output.join("")).toContain("::error file=package.json");
    expect(output.join("")).toContain("New dependency added: unexpected-package");

    output.length = 0;
    await fs.writeFile(path.join(root, "package.json"), '{"name":"sample"}\n');
    const clean = await runCli(["check", "--base", "HEAD~1", "--contract", ".intent/test.yaml", "--format", "github"], root);
    expect(clean).toBe(0);
    expect(output.join("")).toContain("Intent Contract passed");
    expect(output.join("")).not.toContain("::error ");
  });

  it("enforces architecture_drift for a contract passed to check", async () => {
    const root = await createArchitectureRepository();
    await fs.writeFile(path.join(root, "src/billing/invoice.ts"), 'import "../inventory/db";\n');
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);

    const code = await runCli([
      "check", "--base", "HEAD", "--contract", ".intent/architecture.yaml", "--format", "json"
    ], root);
    expect(code).toBe(1);
    expect(JSON.parse(output.join(""))).toMatchObject({
      passed: false,
      errorCount: 1,
      findings: [expect.objectContaining({ detector: "architecture_drift", file: "src/billing/invoice.ts" })]
    });
  });
});

async function createRepository(): Promise<string> {
  vi.spyOn(os, "tmpdir").mockReturnValue(process.cwd());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-cli-test-"));
  temporaryRepositories.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Intent Contract Test"]);
  git(root, ["config", "user.email", "intent-test@example.invalid"]);
  await fs.mkdir(path.join(root, ".intent"), { recursive: true });
  await fs.writeFile(path.join(root, ".intent/test.yaml"), [
    "name: test",
    "intent: Test the CLI",
    "scope:",
    "  modify: [\"**\"]",
    "forbid: [new_dependencies]",
    "allow_exceptions: false"
  ].join("\n") + "\n");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"sample"}\n');
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

async function createArchitectureRepository(): Promise<string> {
  vi.spyOn(os, "tmpdir").mockReturnValue(process.cwd());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-cli-architecture-test-"));
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
