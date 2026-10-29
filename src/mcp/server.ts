import readline from "node:readline";
import packageManifest from "../../package.json";
import { findRepositoryRoot } from "../git/cli";
import {
  getActiveContract,
  revertOutOfScopeFiles,
  startIntentContract,
  verifyIntentContract
} from "../runtime/contracts";
import { readSession } from "../state/session";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export async function handleRpcMessage(message: string, root: string): Promise<string | undefined> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(message) as JsonRpcRequest;
  } catch {
    return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32600, message: "Invalid Request" } });
  }
  const isNotification = !Object.prototype.hasOwnProperty.call(request, "id");
  if (isNotification) return undefined;
  const id = request.id ?? null;
  try {
    let result: unknown;
    if (request.method === "initialize") {
      const requestedVersion = request.params?.protocolVersion;
      const protocolVersion = typeof requestedVersion === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
        ? requestedVersion
        : MCP_PROTOCOL_VERSION;
      result = {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "intent-contract", version: packageManifest.version }
      };
    } else if (request.method === "ping") {
      result = {};
    } else if (request.method === "tools/list") {
      result = { tools: toolDefinitions };
    } else if (request.method === "tools/call") {
      try {
        result = await callTool(root, request.params ?? {});
      } catch (error) {
        result = {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true
        };
      }
    } else {
      return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + request.method } });
    }
    const response: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    return JSON.stringify(response);
  } catch (error) {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: error instanceof Error ? error.message : String(error) }
    };
    return JSON.stringify(response);
  }
}

export async function runMcpServer(workspacePath = process.cwd()): Promise<void> {
  const root = await findRepositoryRoot(workspacePath);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of input) {
    if (!line.trim()) continue;
    const response = await handleRpcMessage(line, root);
    if (response) process.stdout.write(response + "\n");
  }
}

async function callTool(root: string, params: Record<string, unknown>): Promise<unknown> {
  const name = params.name;
  const args = isRecord(params.arguments) ? params.arguments : {};
  if (typeof name !== "string") throw new Error("tools/call requires a tool name.");

  if (name === "get_active_contract") {
    const active = await getActiveContract(root);
    return toolResult({
      path: active.path,
      yaml: active.yaml,
      name: active.contract.name,
      intent: active.contract.intent,
      modify: active.contract.scope.modify,
      read_only: active.contract.scope.read_only,
      modify_symbols: active.contract.scope.modify_symbols ?? [],
      forbid: active.contract.forbid,
      architecture: active.contract.architecture
    });
  }
  if (name === "verify_intent_contract") {
    const verification = await verifyIntentContract(root);
    return toolResult({
      passed: verification.passed,
      errorCount: verification.errorCount,
      warningCount: verification.warningCount,
      findings: verification.findings,
      remediationInstructions: verification.remediationInstructions
    });
  }
  if (name === "revert_out_of_scope_files") {
    let files: string[] | undefined;
    if (args.files !== undefined) {
      if (!Array.isArray(args.files) || args.files.some((file) => typeof file !== "string")) {
        throw new Error("files must be an array of repository-relative paths.");
      }
      files = args.files as string[];
    }
    const reverted = await revertOutOfScopeFiles(root, files);
    return toolResult({ reverted, count: reverted.length });
  }
  if (name === "start_intent_contract") {
    if (typeof args.name !== "string" || !args.name.trim()) throw new Error("name must identify a contract in .intent/.");
    const session = await readSession(root);
    if (session) {
      throw new Error("An Intent Contract session is already active. Agents cannot re-start contracts or re-baseline away active violations.");
    }
    const active = await startIntentContract(root, args.name.trim());
    return toolResult({ started: true, name: active.contract.name, path: active.path, startedAt: active.session.startedAt });
  }
  if (name === "get_remediation_instructions") {
    const verification = await verifyIntentContract(root);
    return toolResult({
      passed: verification.passed,
      violationsCount: verification.findings.length,
      remediationInstructions: verification.remediationInstructions,
      findings: verification.findings
    });
  }
  if (name === "self_heal_contract") {
    const verificationBefore = await verifyIntentContract(root);
    if (verificationBefore.passed) {
      return toolResult({
        healed: true,
        revertedFiles: [],
        message: verificationBefore.findings.length === 0
          ? "No active violations found. Contract is already compliant."
          : `No blocking errors found. Contract is passing with ${verificationBefore.findings.length} warning(s).`,
        remainingViolations: verificationBefore.findings.length,
        findings: verificationBefore.findings
      });
    }
    const reverted = await revertOutOfScopeFiles(root);
    const verificationAfter = await verifyIntentContract(root);
    return toolResult({
      healed: verificationAfter.passed,
      revertedFiles: reverted,
      message: verificationAfter.passed
        ? `Successfully self-healed ${reverted.length} file(s). All active violations cleared.`
        : `Reverted ${reverted.length} file(s). ${verificationAfter.errorCount} error(s) remain requiring code adjustment.`,
      remainingViolations: verificationAfter.findings.length,
      findings: verificationAfter.findings
    });
  }
  throw new Error("Unknown Intent Contract tool: " + name);
}

function toolResult(value: Record<string, unknown>): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function workspaceArgument(argv: string[]): string {
  const index = argv.indexOf("--workspace");
  return index >= 0 && argv[index + 1] ? argv[index + 1] : process.cwd();
}

const toolDefinitions = [
  {
    name: "get_active_contract",
    description: "Return the active Intent Contract and its exact file, symbol, forbidden-rule, and architecture boundaries.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "verify_intent_contract",
    description: "Check the active contract against the current working tree and return findings with remediation instructions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "revert_out_of_scope_files",
    description: "Restore files with active scope violations to the active contract baseline without changing the Git staging index.",
    inputSchema: {
      type: "object",
      properties: { files: { type: "array", items: { type: "string" }, description: "Optional repository-relative subset of scope-violating files." } },
      additionalProperties: false
    }
  },
  {
    name: "start_intent_contract",
    description: "Start a named contract from .intent/ when the user has instructed you to do so.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false }
  },
  {
    name: "get_remediation_instructions",
    description: "Retrieve actionable step-by-step remediation instructions for all active contract findings to guide code correction.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "self_heal_contract",
    description: "Automatically revert out-of-scope files, unauthorized packages, or collateral edits back to the contract baseline to resolve violations.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

if (require.main === module) {
  void runMcpServer(workspaceArgument(process.argv.slice(2))).catch((error: unknown) => {
    process.stderr.write("Intent Contract MCP server failed: " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
