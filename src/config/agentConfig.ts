import fs from "node:fs/promises";
import path from "node:path";
import { gitText } from "../git/cli";

export type AgentIntegration = "cursor" | "antigravity" | "claude" | "copilot" | "precommit";

const START_MARKER = "<!-- BEGIN INTENT CONTRACT GENERATED RULE -->";
const END_MARKER = "<!-- END INTENT CONTRACT GENERATED RULE -->";

export async function configureAgentIntegrations(
  root: string,
  extensionPath: string,
  integrations: AgentIntegration[]
): Promise<string[]> {
  const configured: string[] = [];
  for (const integration of integrations) {
    if (integration === "cursor") {
      await writeMcpConfig(path.join(root, ".cursor", "mcp.json"), serverConfig(extensionPath, root));
      await writeRuleFile(path.join(root, ".cursor", "rules", "intent-contract.mdc"), cursorRule);
      configured.push("Cursor");
    } else if (integration === "antigravity") {
      await writeMcpConfig(path.join(root, ".agents", "mcp_config.json"), serverConfig(extensionPath, root));
      await writeRuleFile(path.join(root, ".agents", "rules", "intent-contract.md"), agentRule);
      configured.push("Google Antigravity");
    } else if (integration === "claude") {
      await writeMcpConfig(path.join(root, ".mcp.json"), serverConfig(extensionPath, root));
      await appendRuleFile(path.join(root, "CLAUDE.md"), agentRule);
      configured.push("Claude Code");
    } else if (integration === "copilot") {
      await writeMcpConfig(path.join(root, ".mcp.json"), serverConfig(extensionPath, root));
      await appendRuleFile(path.join(root, ".github", "copilot-instructions.md"), agentRule);
      configured.push("GitHub Copilot");
    } else if (integration === "precommit") {
      await installPreCommitHook(root, path.join(extensionPath, "dist", "cli.js"));
      configured.push("Git pre-commit hook");
    }
  }
  return configured;
}

export function mergeMcpConfig(source: string | undefined, config: Record<string, unknown>): string {
  let value: Record<string, unknown> = {};
  if (source?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error("Existing MCP config is not valid JSON: " + (error instanceof Error ? error.message : String(error)));
    }
    if (!isRecord(parsed)) throw new Error("Existing MCP config must contain a JSON object.");
    value = parsed;
  }
  const currentServers = value.mcpServers;
  if (currentServers !== undefined && !isRecord(currentServers)) {
    throw new Error("Existing MCP config field mcpServers must be a JSON object.");
  }
  const servers = { ...(isRecord(currentServers) ? currentServers : {}), "intent-contract": config };
  return JSON.stringify({ ...value, mcpServers: servers }, null, 2) + "\n";
}

export function upsertMarkedRule(source: string, rule: string): string {
  const block = START_MARKER + "\n" + rule.trim() + "\n" + END_MARKER;
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  if (start >= 0 && end >= start) {
    const after = end + END_MARKER.length;
    return source.slice(0, start) + block + source.slice(after);
  }
  const separator = source.length === 0 || source.endsWith("\n") ? "" : "\n";
  return source + separator + (source.length === 0 ? "" : "\n") + block + "\n";
}

export async function writeMcpConfig(filePath: string, config: Record<string, unknown>): Promise<void> {
  await assertRegularFileOrMissing(filePath);
  const source = await readIfPresent(filePath);
  const merged = mergeMcpConfig(source, config);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, merged, "utf8");
}

export async function writeRuleFile(filePath: string, rule: string): Promise<void> {
  await assertRegularFileOrMissing(filePath);
  let source = await readIfPresent(filePath) ?? "";
  if (filePath.endsWith(".mdc") && !source.startsWith("---")) {
    source = "---\ndescription: Intent Contract boundaries\nalwaysApply: true\n---\n\n" + source;
  }
  const next = upsertMarkedRule(source, rule);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, next, "utf8");
}

export async function appendRuleFile(filePath: string, rule: string): Promise<void> {
  await assertRegularFileOrMissing(filePath);
  const source = await readIfPresent(filePath) ?? "";
  const next = upsertMarkedRule(source, rule);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, next, "utf8");
}

export async function installPreCommitHook(root: string, cliPath: string): Promise<void> {
  const hookPath = path.resolve(root, (await gitText(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"])).trim());
  await assertRegularFileOrMissing(hookPath);
  const existing = await readIfPresent(hookPath) ?? "";
  const block = [
    START_MARKER,
    "if [ -f .intent/.state.json ]; then",
    "  node " + shellQuote(cliPath) + " check",
    "  intent_contract_status=$?",
    "  if [ \"$intent_contract_status\" -ne 0 ]; then exit \"$intent_contract_status\"; fi",
    "fi",
    END_MARKER
  ].join("\n");
  const updated = upsertHookBlock(existing, block);
  await fs.mkdir(path.dirname(hookPath), { recursive: true });
  await fs.writeFile(hookPath, updated, "utf8");
  try {
    await fs.chmod(hookPath, 0o755);
  } catch {
    // chmod is not available for every filesystem used by Windows workspaces.
  }
}

export function serverConfig(extensionPath: string, workspace: string): Record<string, unknown> {
  return {
    command: "node",
    args: [path.join(extensionPath, "dist", "mcp-server.js"), "--workspace", workspace]
  };
}

function upsertHookBlock(source: string, block: string): string {
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER, start + START_MARKER.length);
  let result: string;
  if (start >= 0 && end >= start) {
    const after = end + END_MARKER.length;
    result = source.slice(0, start) + block + source.slice(after);
  } else {
    const lines = source.replace(/\r\n/g, "\n").split("\n");
    if (lines[0]?.startsWith("#!")) {
      lines.splice(1, 0, block, "");
      result = lines.join("\n");
    } else {
      result = "#!/bin/sh\n" + block + "\n" + source;
    }
  }
  return result.endsWith("\n") ? result : result + "\n";
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function assertRegularFileOrMissing(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) throw new Error("Refusing to overwrite a symbolic link: " + filePath);
    if (!stat.isFile()) throw new Error("Expected a regular file: " + filePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

const agentRule = "When an Intent Contract is active (.intent/.state.json exists), you MUST call get_active_contract before editing files and verify_intent_contract before finishing your task. Do not finish with unresolved error findings.";
const cursorRule = "---\ndescription: Check Intent Contract boundaries before and after changes\nalwaysApply: true\n---\n\n" +
  START_MARKER + "\n" + agentRule + "\n" + END_MARKER + "\n";
