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

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
}
