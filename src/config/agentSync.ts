import fs from "node:fs/promises";
import path from "node:path";
import type { Contract } from "../contract/schema";

const TASK_START_TAG = "<!-- INTENT_CONTRACT_ACTIVE_TASK_START -->";
const TASK_END_TAG = "<!-- INTENT_CONTRACT_ACTIVE_TASK_END -->";

export interface SyncTarget {
  name: string;
  relativePath: string;
}

const AGENT_TARGETS: SyncTarget[] = [
  { name: "Cursor Rules", relativePath: ".cursor/rules/intent-contract.mdc" },
  { name: "Antigravity Rules", relativePath: ".agents/rules/intent-contract.md" },
  { name: "Claude Instructions", relativePath: "CLAUDE.md" },
  { name: "Copilot Instructions", relativePath: ".github/copilot-instructions.md" }
];

export async function syncActiveContractToAgents(root: string, contract: Contract): Promise<string[]> {
  const content = renderTaskPromptSection(contract);
  const updatedTargets: string[] = [];

  for (const target of AGENT_TARGETS) {
    const fullPath = path.join(root, target.relativePath);
    const parentDir = path.dirname(fullPath);

    let parentExists = false;
    try {
      const stat = await fs.stat(parentDir);
      parentExists = stat.isDirectory();
    } catch {
      parentExists = false;
    }

    let fileExists = false;
    let existingContent = "";
    try {
      existingContent = await fs.readFile(fullPath, "utf8");
      fileExists = true;
    } catch {
      fileExists = false;
    }

    if (!fileExists) {
      // Do not automatically create .github/copilot-instructions.md or CLAUDE.md if they do not exist.
      // .github is a standard repo directory for workflows/CI; its presence does not mean Copilot instructions should be synthesized.
      if (target.relativePath === ".github/copilot-instructions.md" || target.relativePath === "CLAUDE.md") {
        continue;
      }
      if (!target.relativePath.includes("/") || !parentExists) {
        continue;
      }
    }

    try {
      if (parentExists) {
        await fs.mkdir(parentDir, { recursive: true });
      }
      const newContent = injectTaskSection(existingContent, content);
      await fs.writeFile(fullPath, newContent, "utf8");
      updatedTargets.push(target.name);
    } catch {
      // Continue even if one agent config fails to write
    }
  }

  return updatedTargets;
}

export async function clearActiveContractFromAgents(root: string): Promise<string[]> {
  const dormantContent = `${TASK_START_TAG}\n<!-- No active Intent Contract session. Start a contract via 'Intent Contract: Start Contract' in VS Code. -->\n${TASK_END_TAG}`;
  const updatedTargets: string[] = [];

  for (const target of AGENT_TARGETS) {
    const fullPath = path.join(root, target.relativePath);
    try {
      const existingContent = await fs.readFile(fullPath, "utf8");
      if (existingContent.includes(TASK_START_TAG)) {
        const userContent = extractUserContent(existingContent);
        if (!userContent) {
          // If the file only contained our Intent Contract markers, remove it so no dormant untracked file remains
          await fs.unlink(fullPath);
          updatedTargets.push(target.name);
        } else {
          const newContent = injectTaskSection(existingContent, dormantContent);
          await fs.writeFile(fullPath, newContent, "utf8");
          updatedTargets.push(target.name);
        }
      }
    } catch {
      // Ignore if file doesn't exist
    }
  }

  return updatedTargets;
}

export function extractUserContent(content: string): string {
  const startIndex = content.indexOf(TASK_START_TAG);
  const endIndex = content.indexOf(TASK_END_TAG);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return content.trim();
  }

  const before = content.slice(0, startIndex);
  const after = content.slice(endIndex + TASK_END_TAG.length);
  return `${before.trim()}\n${after.trim()}`.trim();
}

function renderTaskPromptSection(contract: Contract): string {
  const modifyList = contract.scope.modify.map((m) => `- \`${m}\``).join("\n");
  const symbolList = contract.scope.modify_symbols?.length
    ? contract.scope.modify_symbols.map((s) => `- \`${s}\``).join("\n")
    : "- All top-level symbols inside permitted files";
  const readOnlyList = contract.scope.read_only.length
    ? contract.scope.read_only.map((r) => `- \`${r}\``).join("\n")
    : "- None";
  const forbidList = contract.forbid.map((f) => `- \`${f}\``).join("\n");

  const archSection = contract.architecture
    ? `\n### 📐 Architecture Boundaries\n- Diagram policy: \`${contract.architecture.diagram}\`\n- Cross-module imports not drawn in this diagram are strictly prohibited.\n`
    : "";

  return `${TASK_START_TAG}
## 🛡️ Active Task Intent Contract: ${contract.name}
**Task Intent**: ${contract.intent}

### 📂 Permitted Modify Scope (Files You May Modify)
${modifyList}

### 🔣 Permitted Symbol Scope
${symbolList}

### 🔒 Strictly Read-Only (Do NOT Touch or Modify)
${readOnlyList}

### 🚫 Strictly Forbidden Actions
${forbidList}${archSection}
> [!IMPORTANT]
> This repository is actively guarded by **Intent Contract**. Before finishing your turn or reporting completion, invoke the MCP tool \`verify_intent_contract\` or \`self_heal_contract\` to ensure zero active violations.
${TASK_END_TAG}`;
}

function injectTaskSection(existing: string, section: string): string {
  const startIndex = existing.indexOf(TASK_START_TAG);
  const endIndex = existing.indexOf(TASK_END_TAG);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const before = existing.slice(0, startIndex);
    const after = existing.slice(endIndex + TASK_END_TAG.length);
    return `${before.trimEnd()}\n\n${section}\n\n${after.trimStart()}`.trim() + "\n";
  }

  if (!existing.trim()) {
    return section + "\n";
  }

  return `${existing.trimEnd()}\n\n${section}\n`;
}
