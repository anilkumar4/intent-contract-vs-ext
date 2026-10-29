import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { configureAgentIntegrations, installPreCommitHook, installPrePushHook, mergeMcpConfig, serverConfig, upsertMarkedRule } from "../../src/config/agentConfig";

describe("AI agent configuration helpers", () => {
  it("adds Intent Contract MCP while preserving existing servers and settings", () => {
    const existing = JSON.stringify({
      mcpServers: { playwright: { command: "npx", args: ["playwright-mcp"] } },
      customSetting: true
    });
    const merged = JSON.parse(mergeMcpConfig(existing, { command: "node", args: ["server.js"] })) as {
      mcpServers: Record<string, unknown>;
      customSetting: boolean;
    };
    expect(merged.customSetting).toBe(true);
    expect(merged.mcpServers.playwright).toEqual({ command: "npx", args: ["playwright-mcp"] });
    expect(merged.mcpServers["intent-contract"]).toEqual({ command: "node", args: ["server.js"] });
  });

  it("does not replace a malformed MCP config", () => {
    expect(() => mergeMcpConfig("{ broken", { command: "node" })).toThrow(/not valid JSON/);
  });

  it("writes GitHub Copilot MCP configuration to the VS Code servers file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-copilot-config-test-"));
    try {
      await configureAgentIntegrations(root, root, ["copilot"]);
      const config = JSON.parse(await fs.readFile(path.join(root, ".vscode/mcp.json"), "utf8")) as {
        servers: Record<string, unknown>;
      };
      expect(config.servers["intent-contract"]).toBeDefined();
      await expect(fs.access(path.join(root, ".mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("creates a stable launcher entrypoint that exists on disk and survives extension updates", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-mcp-launcher-test-"));
    try {
      const versionedFolder = path.join(tempDir, "anilkumar4.intent-contract-0.2.0");
      const distFolder = path.join(versionedFolder, "dist");
      await fs.mkdir(distFolder, { recursive: true });
      await fs.writeFile(path.join(distFolder, "mcp-server.js"), "console.log('original server');");

      const config = serverConfig(versionedFolder, "/workspace");
      const serverEntrypoint = (config.args as string[])[0];
      expect(serverEntrypoint).toBeDefined();
      expect(await fs.stat(serverEntrypoint)).toBeDefined();

      // Ensure the unversioned launcher points to the existing file
      expect(serverEntrypoint).not.toContain("-0.2.0");
      expect(serverEntrypoint).toContain("anilkumar4.intent-contract");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("updates its generated rule block without duplicating it", () => {
    const first = upsertMarkedRule("User instructions.\n", "Call the contract tools.");
    const second = upsertMarkedRule(first, "Call the contract tools before finishing.");
    expect(second.match(/BEGIN INTENT CONTRACT GENERATED RULE/g)).toHaveLength(1);
    expect(second).toContain("User instructions.");
    expect(second).toContain("Call the contract tools before finishing.");
  });

  it("installs pre-commit and pre-push hooks that block on active contract violations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-hook-test-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      await installPreCommitHook(root, "/fake/cli.js");
      await installPrePushHook(root, "/fake/cli.js");

      const preCommit = await fs.readFile(path.join(root, ".git/hooks/pre-commit"), "utf8");
      expect(preCommit).toContain("intent_contract_status");
      expect(preCommit).toContain("Commit BLOCKED");
      expect(preCommit).toContain("check --index");

      const prePush = await fs.readFile(path.join(root, ".git/hooks/pre-push"), "utf8");
      expect(prePush).toContain("intent_contract_status");
      expect(prePush).toContain("Git push BLOCKED!");
      expect(prePush).toContain('check --revision "$local_sha"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("real pre-commit hook execution actually blocks git commit when staged index violates active contract", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-real-hook-"));
    const cliPath = path.resolve(__dirname, "../../dist/cli.js");
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "config", "user.name", "Hook Test"]);
      execFileSync("git", ["-C", root, "config", "user.email", "hook@test.local"]);

      // Initial clean commit
      await fs.mkdir(path.join(root, ".intent"), { recursive: true });
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.mkdir(path.join(root, "test"), { recursive: true });
      await fs.writeFile(path.join(root, ".intent/test.yaml"), [
        "name: test",
        "intent: Only allow src",
        "scope:",
        "  modify: [src/**]",
        "  read_only: [test/**]",
        "forbid: []",
        "allow_exceptions: false"
      ].join("\n") + "\n");
      await fs.writeFile(path.join(root, "src/app.ts"), "export const a = 1;\n");
      await fs.writeFile(path.join(root, "test/locked.txt"), "protected baseline\n");
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-m", "initial"]);

      // Install hooks using actual built dist/cli.js
      await installPreCommitHook(root, cliPath);

      // Start contract
      const { startIntentContract } = await import("../../src/runtime/contracts");
      await startIntentContract(root, "test");

      // 1. Staging permitted file should allow git commit
      await fs.writeFile(path.join(root, "src/app.ts"), "export const a = 2;\n");
      execFileSync("git", ["-C", root, "add", "src/app.ts"]);
      expect(() => {
        execFileSync("git", ["-C", root, "commit", "-m", "permitted change"], { stdio: "pipe" });
      }).not.toThrow();

      // 2. Staging a read-only violation should block git commit!
      await fs.writeFile(path.join(root, "test/locked.txt"), "tampered content\n");
      execFileSync("git", ["-C", root, "add", "test/locked.txt"]);
      let blockedError: any;
      try {
        execFileSync("git", ["-C", root, "commit", "-m", "violating change"], { stdio: "pipe" });
      } catch (err: any) {
        blockedError = err;
      }
      expect(blockedError).toBeDefined();
      const stderr = blockedError?.stderr?.toString() ?? "";
      expect(stderr).toContain("Commit BLOCKED");

      // 3. Pre-push hook blocks git push when pushing a revision containing violations!
      const bareRemote = await fs.mkdtemp(path.join(os.tmpdir(), "intent-bare-remote-"));
      try {
        execFileSync("git", ["init", "--bare", "-q", bareRemote]);
        execFileSync("git", ["-C", root, "remote", "add", "origin", bareRemote]);
        await installPrePushHook(root, cliPath);

        // Commit with --no-verify to bypass pre-commit hook so revision exists locally
        execFileSync("git", ["-C", root, "commit", "-n", "-m", "bypassed commit"]);

        // Pushing this revision to remote MUST be blocked by pre-push hook!
        let pushBlockedError: any;
        try {
          execFileSync("git", ["-C", root, "push", "origin", "HEAD:main"], { stdio: "pipe" });
        } catch (err: any) {
          pushBlockedError = err;
        }
        expect(pushBlockedError).toBeDefined();
        const pushStderr = pushBlockedError?.stderr?.toString() ?? "";
        expect(pushStderr).toContain("Git push BLOCKED!");
      } finally {
        await fs.rm(bareRemote, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
