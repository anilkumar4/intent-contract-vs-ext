import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli";
import { getActiveContract, startIntentContract, stopIntentContract, verifyIntentContract } from "../../src/runtime/contracts";
import { writeSession } from "../../src/state/session";
import { addWaiver } from "../../src/state/waivers";

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

    await fs.writeFile(path.join(root, ".intent/architecture.yaml"),
      (await fs.readFile(path.join(root, ".intent/architecture.yaml"), "utf8"))
        .replace("forbid: [architecture_drift]", "forbid: []"));
    output.length = 0;
    const policyLocked = await runCli([
      "check", "--base", "HEAD", "--contract", ".intent/architecture.yaml", "--format", "json"
    ], root);
    expect(policyLocked).toBe(1);
    const lockedResult = JSON.parse(output.join("")) as { passed: boolean; findings: Array<{ detector: string; file: string }> };
    expect(lockedResult.passed).toBe(false);
    expect(lockedResult.findings).toContainEqual(expect.objectContaining({
      detector: "architecture_drift", file: "src/billing/invoice.ts"
    }));
  });

  it("checks the staged index and pushed revision instead of the working tree", async () => {
    const root = await createRepository();
    await startIntentContract(root, "test");
    const originalPackage = await fs.readFile(path.join(root, "package.json"), "utf8");
    await fs.writeFile(path.join(root, "package.json"), '{"name":"sample","dependencies":{"unexpected-package":"1.0.0"}}\n');
    git(root, ["add", "package.json"]);
    await fs.writeFile(path.join(root, "package.json"), originalPackage);

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);
    expect(await runCli(["check", "--format", "json"], root)).toBe(0);
    expect(await runCli(["check", "--index", "--format", "json"], root)).toBe(1);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      findings: [expect.objectContaining({ detector: "dependencies", severity: "error", file: "package.json" })]
    });

    git(root, ["commit", "-m", "introduce staged dependency"]);
    const pushedRevision = git(root, ["rev-parse", "HEAD"]).trim();
    await fs.writeFile(path.join(root, "package.json"), originalPackage);
    expect(await runCli(["check", "--revision", pushedRevision, "--format", "json"], root)).toBe(1);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      findings: [expect.objectContaining({ detector: "dependencies", severity: "error", file: "package.json" })]
    });
  });

  it("requires explicit force to replace an active baseline and releases old references safely", async () => {
    const root = await createRepository();
    const first = await startIntentContract(root, "test");
    await expect(startIntentContract(root, "test")).rejects.toThrow(/already active/);

    await fs.writeFile(path.join(root, "README.md"), "new baseline content\n");
    const replacement = await startIntentContract(root, "test", { force: true });
    expect(replacement.session.baselineTreeHash).toBe(replacement.session.originalBaselineTreeHash);
    expect(replacement.session.baselineTreeHash).not.toBe(first.session.baselineTreeHash);
    expect(() => git(root, ["show-ref", "--verify", "--quiet", first.session.baselineRef])).toThrow();
  });

  it("pins and later releases a distinct legacy policy baseline", async () => {
    const root = await createRepository();
    const started = await startIntentContract(root, "test");
    const legacyPolicyTree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
    await writeSession(root, { ...started.session, originalBaselineTreeHash: legacyPolicyTree });

    const active = await getActiveContract(root);
    expect(active.session.originalBaselineRef).toMatch(/^refs\/intent-contract\/baselines\/policy-/);
    expect(git(root, ["rev-parse", `${active.session.originalBaselineRef}^{tree}`]).trim()).toBe(legacyPolicyTree);

    await stopIntentContract(root);
    expect(() => git(root, ["show-ref", "--verify", "--quiet", active.session.originalBaselineRef!])).toThrow();
  });

  it("does not let persisted waivers suppress findings when the baseline contract disables exceptions", async () => {
    const root = await createRepository();
    await startIntentContract(root, "test");
    await fs.writeFile(path.join(root, "package.json"), '{"name":"sample","dependencies":{"unexpected-package":"1.0.0"}}\n');

    const firstCheck = await verifyIntentContract(root);
    const finding = firstCheck.findings[0];
    expect(finding).toBeDefined();
    await addWaiver(root, {
      id: finding!.id,
      reason: "Fabricated persisted waiver",
      timestamp: new Date().toISOString()
    });

    const secondCheck = await verifyIntentContract(root);
    expect(secondCheck.findings).toContainEqual(expect.objectContaining({ id: finding!.id, severity: "error" }));
  });

  it("prints vibe coding guide overview and exits cleanly", async () => {
    const root = await createRepository();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);

    const code = await runCli(["guide"], root);
    expect(code).toBe(0);
    expect(output.join("")).toContain("Intent Contract Vibe Coding Guide:");
    expect(output.join("")).toContain("vibe-coding-guide.md");
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
