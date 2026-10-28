import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { syncActiveContractToAgents, clearActiveContractFromAgents } from "../../src/config/agentSync";
import type { Contract } from "../../src/contract/schema";

describe("Agent prompt hot-sync", () => {
  const sampleContract: Contract = {
    name: "feature-checkout",
    intent: "Implement Stripe checkout flow",
    scope: {
      modify: ["src/checkout/**", "src/billing/**"],
      read_only: ["src/security/**"],
      modify_symbols: ["processPayment", "validateCart"]
    },
    forbid: ["new_dependencies", "test_weakening"],
    allow_exceptions: false
  };

  it("syncs active contract constraints into existing agent instruction files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-agent-sync-test-"));
    try {
      // Create user's custom instructions
      const cursorDir = path.join(root, ".cursor/rules");
      await fs.mkdir(cursorDir, { recursive: true });
      await fs.writeFile(path.join(cursorDir, "intent-contract.mdc"), "# Cursor Rules\n\nAlways use TypeScript.\n");

      await fs.writeFile(path.join(root, "CLAUDE.md"), "# Project Instructions\n\nFollow clean code.\n");

      const updated = await syncActiveContractToAgents(root, sampleContract);
      expect(updated).toContain("Cursor Rules");
      expect(updated).toContain("Claude Instructions");

      // Verify Cursor file preserves existing rules and appends contract
      const cursorContent = await fs.readFile(path.join(cursorDir, "intent-contract.mdc"), "utf8");
      expect(cursorContent).toContain("Always use TypeScript.");
      expect(cursorContent).toContain("feature-checkout");
      expect(cursorContent).toContain("src/checkout/**");
      expect(cursorContent).toContain("processPayment");
      expect(cursorContent).toContain("src/security/**");

      // Verify CLAUDE.md
      const claudeContent = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
      expect(claudeContent).toContain("Follow clean code.");
      expect(claudeContent).toContain("Implement Stripe checkout flow");

      // Now clear when contract stops
      const cleared = await clearActiveContractFromAgents(root);
      expect(cleared).toContain("Cursor Rules");
      expect(cleared).toContain("Claude Instructions");

      const cursorAfter = await fs.readFile(path.join(cursorDir, "intent-contract.mdc"), "utf8");
      expect(cursorAfter).toContain("Always use TypeScript.");
      expect(cursorAfter).not.toContain("feature-checkout");
      expect(cursorAfter).toContain("No active Intent Contract session");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("safely handles workspaces without any agent config files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-agent-empty-test-"));
    try {
      const updated = await syncActiveContractToAgents(root, sampleContract);
      expect(updated).toEqual([]);
      const cleared = await clearActiveContractFromAgents(root);
      expect(cleared).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not synthesize .github/copilot-instructions.md just because .github/ exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-agent-github-test-"));
    try {
      const githubWorkflowDir = path.join(root, ".github/workflows");
      await fs.mkdir(githubWorkflowDir, { recursive: true });
      await fs.writeFile(path.join(githubWorkflowDir, "ci.yml"), "name: CI\n");

      const updated = await syncActiveContractToAgents(root, sampleContract);
      expect(updated).not.toContain("Copilot Instructions");

      // Verify .github/copilot-instructions.md was NOT created
      const copilotFile = path.join(root, ".github/copilot-instructions.md");
      let exists = false;
      try {
        await fs.access(copilotFile);
        exists = true;
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("unlinks files on clear if they contain no other user content, leaving zero untracked files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-agent-unlink-test-"));
    try {
      const agentsDir = path.join(root, ".agents/rules");
      await fs.mkdir(agentsDir, { recursive: true });

      // Start contract generates .agents/rules/intent-contract.md with no existing user content
      const updated = await syncActiveContractToAgents(root, sampleContract);
      expect(updated).toContain("Antigravity Rules");

      const agentRulePath = path.join(agentsDir, "intent-contract.md");
      await expect(fs.readFile(agentRulePath, "utf8")).resolves.toContain("feature-checkout");

      // Stop contract cleans up
      const cleared = await clearActiveContractFromAgents(root);
      expect(cleared).toContain("Antigravity Rules");

      // Verify file was unlinked and does NOT linger as untracked file
      let exists = false;
      try {
        await fs.access(agentRulePath);
        exists = true;
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

