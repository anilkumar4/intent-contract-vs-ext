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
});

