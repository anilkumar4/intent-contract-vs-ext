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
});
