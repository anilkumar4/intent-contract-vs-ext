#!/usr/bin/env node
import path from "node:path";
import { findRepositoryRoot } from "../git/cli";
import { normalizeContractPath, revertIntentFile, startIntentContract, stopIntentContract, verifyIntentContract } from "../runtime/contracts";
import { installPreCommitHook, installPrePushHook } from "../config/agentConfig";
import type { Finding } from "../detectors/types";

type OutputFormat = "text" | "json" | "github";

interface CheckOptions {
  base?: string;
  contractPath?: string;
  format: OutputFormat;
  index?: boolean;
  revision?: string;
}

export async function runCli(argv: string[], workingDirectory = process.cwd()): Promise<number> {
  const workspaceIndex = argv.indexOf("--workspace");
  const workspace = workspaceIndex >= 0 && argv[workspaceIndex + 1] ? path.resolve(workingDirectory, argv[workspaceIndex + 1]) : workingDirectory;
  const filtered = [...argv];
  if (workspaceIndex >= 0) filtered.splice(workspaceIndex, 2);
  const command = filtered[0];
  if (!command || command === "--help" || command === "-h") {
    writeUsage();
    return command ? 0 : 2;
  }
  if (filtered.includes("--help") || filtered.includes("-h")) {
    writeUsage();
    return 0;
  }

  try {
    const root = await findRepositoryRoot(workspace);
    if (command === "start") {
      const force = filtered.includes("--force") || filtered.includes("-f");
      const name = filtered.find((arg, idx) => idx > 0 && !arg.startsWith("-"));
      if (!name) throw new Error("Usage: intent-contract start <contract-name> [--force]");
      const started = await startIntentContract(root, name, { force });
      process.stdout.write("Started contract \"" + started.contract.name + "\" from " + started.path + ".\n");
      return 0;
    }
    if (command === "check") {
      const options = parseCheckOptions(filtered.slice(1));
      const result = await verifyIntentContract(root, options);
      writeCheckResult(result.findings, result.errorCount, result.warningCount, result.passed, options.format);
      return result.passed ? 0 : 1;
    }
    if (command === "revert") {
      const file = filtered[1];
      if (!file) throw new Error("Usage: intent-contract revert <file>");
      const repoPath = normalizeContractPath(file, root);
      await revertIntentFile(root, repoPath);
      process.stdout.write("Restored " + repoPath + " to the active Intent Contract baseline.\n");
      return 0;
    }
    if (command === "stop") {
      await stopIntentContract(root);
      process.stdout.write("Stopped the active Intent Contract.\n");
      return 0;
    }
    if (command === "hook") {
      const sub = filtered[1];
      if (sub === "install" || !sub) {
        const cliPath = path.resolve(__dirname, "cli.js");
        await installPreCommitHook(root, cliPath);
        await installPrePushHook(root, cliPath);
        process.stdout.write("Installed Git pre-commit and pre-push hooks.\n");
        return 0;
      }
      throw new Error("Usage: intent-contract hook install");
    }
    throw new Error("Unknown command: " + command);
  } catch (error) {
    process.stderr.write("intent-contract: " + (error instanceof Error ? error.message : String(error)) + "\n");
    return 2;
  }
}

function parseCheckOptions(args: string[]): CheckOptions {
  const options: CheckOptions = { format: "text" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base") options.base = requireValue(args, ++index, "--base");
    else if (arg === "--contract") options.contractPath = requireValue(args, ++index, "--contract");
    else if (arg === "--index") options.index = true;
    else if (arg === "--revision") options.revision = requireValue(args, ++index, "--revision");
    else if (arg === "--format") {
      const value = requireValue(args, ++index, "--format");
      if (value !== "text" && value !== "json" && value !== "github") throw new Error("--format must be text, json, or github.");
      options.format = value;
    } else if (arg === "--help" || arg === "-h") {
      writeUsage();
      return options;
    } else throw new Error("Unknown check option: " + arg);
  }
  if (options.index && options.revision) throw new Error("--index and --revision cannot be used together.");
  return options;
}

function writeCheckResult(findings: Finding[], errors: number, warnings: number, passed: boolean, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(JSON.stringify({ passed, errorCount: errors, warningCount: warnings, findings }, null, 2) + "\n");
    return;
  }
  if (format === "github") {
    for (const finding of findings) {
      const level = finding.severity === "error" ? "error" : "warning";
      const properties = "file=" + escapeProperty(finding.file) + (finding.line ? ",line=" + finding.line : "");
      process.stdout.write("::" + level + " " + properties + "::" + escapeData(finding.message) + "\n");
    }
    process.stdout.write("Intent Contract " + (passed ? "passed" : "failed") + ": " + errors + " error(s), " + warnings + " warning(s).\n");
    return;
  }

  process.stdout.write("Intent Contract " + (passed ? "passed" : "failed") + ": " + errors + " error(s), " + warnings + " warning(s).\n");
  if (findings.length === 0) {
    process.stdout.write("No findings.\n");
    return;
  }
  for (const finding of findings) {
    process.stdout.write(
      finding.severity.toUpperCase() + " " + finding.file + (finding.line ? ":" + finding.line : "") +
      " [" + (finding.rule ?? finding.detector) + "]: " + finding.message + "\n"
    );
    if (finding.evidence) process.stdout.write("  " + finding.evidence.replace(/\r?\n/g, " ") + "\n");
  }
}

function escapeProperty(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(option + " requires a value.");
  return value;
}

function writeUsage(): void {
  process.stdout.write(
    "Intent Contract CLI\n\n" +
    "  intent-contract start <contract-name> [--force]\n" +
    "  intent-contract check [--base <git-ref>] [--contract <path>] [--format text|json|github] [--index | --revision <commit>]\n" +
    "  intent-contract revert <file>\n" +
    "  intent-contract hook install\n" +
    "  intent-contract stop\n" +
    "  intent-contract --workspace <repo-path> <command>\n"
  );
}

if (require.main === module) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write("intent-contract: " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 2;
  });
}
