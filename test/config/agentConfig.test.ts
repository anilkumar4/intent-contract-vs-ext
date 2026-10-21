import { describe, expect, it } from "vitest";
import { mergeMcpConfig, upsertMarkedRule } from "../../src/config/agentConfig";

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

  it("updates its generated rule block without duplicating it", () => {
    const first = upsertMarkedRule("User instructions.\n", "Call the contract tools.");
    const second = upsertMarkedRule(first, "Call the contract tools before finishing.");
    expect(second.match(/BEGIN INTENT CONTRACT GENERATED RULE/g)).toHaveLength(1);
    expect(second).toContain("User instructions.");
    expect(second).toContain("Call the contract tools before finishing.");
  });
});
