# Intent Contract: Project Architecture

This guide describes the implementation in this repository and pairs with [the editable Draw.io architecture diagram](intent-contract-architecture.drawio). The extension, command-line tool, and MCP server share one contract and detector runtime so the same policy produces the same findings in each integration.

## What the project does

Intent Contract captures a Git tree as the baseline for a task. A YAML contract defines which files and symbols may change and which risks are forbidden. The tool compares the current working tree with that baseline, evaluates the changes, and reports findings with severity, file, line when available, evidence, and remediation.

It reports changes after they are written; it does not prevent an editor or agent from writing a file. The extension adds diagnostics, an Explorer findings tree, status-bar state, baseline diffs, waivers, and a restore action.

## Main components

| Component | Source | Responsibility |
| --- | --- | --- |
| VS Code extension | **src/extension.ts**, **src/ui/** | Commands, workspace watcher, contract session UI, diagnostics, status bar, findings tree, diff/revert/waive actions, and architecture preview. |
| Contract schema and loader | **src/contract/** | Discover YAML contracts, parse and validate their schema, create a starter contract, and keep generated session metadata ignored. |
| Shared runtime | **src/runtime/contracts.ts** | Start and stop sessions, load the baseline contract, capture the current tree, run verification, apply waivers, and format remediation instructions. |
| Git snapshot and diff | **src/git/** | Capture a baseline using a temporary Git index, compare trees, retain before/after text and line hunks, and restore files without changing the user's Git index. |
| Detector pipeline | **src/detectors/index.ts** | Run scope, symbol, dependency, high-risk, test-integrity, and architecture detectors, then deduplicate and sort findings. |
| Architecture parser | **src/architecture/diagramParser.ts** | Normalize Mermaid, C4 Mermaid, Mermaid Markdown sections, and Draw.io diagrams into nodes with labels/globs and directed allowed edges. |
| Architecture detector | **src/detectors/architectureDrift.ts** | Resolve imports in changed source files to diagram nodes and report cross-module dependencies without a directed edge. |
| CLI | **src/cli/index.ts** | Provide start, check, revert, and stop; check supports text, JSON, and GitHub annotation output. |
| MCP server | **src/mcp/server.ts** | Expose active-contract, verification, revert, and start tools using JSON-RPC over stdio. |
| Agent setup | **src/config/agentConfig.ts** | Configure supported agent instructions and MCP entries while preserving existing configuration. |

At build time, esbuild bundles the extension, CLI, and MCP server into **dist/**. The build then packages those artifacts and the extension manifest into **intent-contract.vsix**.

## Contract and policy inputs

A contract can opt into architecture enforcement:

```yaml
name: billing-change
intent: Keep billing changes within the approved module boundaries
scope:
  modify: ["src/billing/**", "src/shared/**"]
  read_only: []
architecture:
  diagram: "docs/system.mmd"
  node_mappings:
    Billing: ["src/billing/**"]
    Shared: ["src/shared/**"]
    Inventory: ["src/inventory/**"]
  default_policy: "deny_unlisted_edges"
forbid:
  - architecture_drift
allow_exceptions: false
```

The architecture block is optional. When architecture_drift is listed in forbid, the schema requires an architecture block. Node mappings associate a diagram node ID or visible label with repository globs. Inline glob tags such as [src/billing/**] in a diagram node label are also accepted and merged with contract mappings. A path matching multiple nodes is ambiguous and produces a warning.

The contract and diagram are read from the policy baseline during verification. The CLI reads the contract from the same tree used for the check: the explicit `--base`, the active session baseline, or `HEAD`. The contract path must exist in that tree. Changing the contract mappings, forbid list, or diagram in the same working-tree change therefore cannot authorize a new dependency in that check. To adopt a revised policy, update the policy files and select a new baseline.

## Baseline and verification flow

1. **Start:** the extension, CLI, or MCP calls the shared runtime. The runtime validates the selected contract, prepares ignored .intent metadata, and captures the repository state using a temporary Git index. The real Git staging index remains untouched.
2. **Change detection:** the extension checks after editor saves and file-system events, or the CLI/MCP checks on demand. Git comparison identifies modified, added, deleted, and renamed files and retains their current content and line hunks.
3. **Contract evaluation:** the detector pipeline runs the relevant detectors. Architecture checking runs only when the active contract includes architecture_drift.
4. **Reporting:** findings are deduplicated and sorted. The extension updates diagnostics, the tree, status bar, and .intent/.violations.md; the CLI returns its selected output format and exit code; MCP returns structured findings and remediation instructions.
5. **Restore or waive:** a restore action reads the captured baseline. A waiver requires an explanation and is available only when the contract allows exceptions.

## Diagram normalization

The parser is local TypeScript and Node built-ins only; it adds no parser package. Its normalized graph contains a map from node ID to a record with id, label, and globs, plus a set of directed strings such as Billing->Shared.

### Mermaid flowcharts

MMD files support graph and flowchart declarations in TD, LR, BT, and RL directions. The parser recognizes normal arrows, dotted arrows, thick arrows, chains, and explicit bidirectional arrows. It ignores %% comments. A label such as Billing [src/billing/**] contributes the visible label Billing and the glob src/billing/**.

### C4 Mermaid

C4 declarations such as Person, System, Container, Component, and common external/database variants create nodes. Rel creates a directed edge, Rel_Back reverses it, and BiRel creates both directions. C4 blocks are accepted even when they do not use a flowchart header.

### Mermaid inside Markdown

Markdown references can select Mermaid fences in a file or a single section, for example README.md#architecture. Heading anchors are slugged from heading text. Fences may use backticks or tildes.

### Draw.io

Draw.io .drawio and .dio files are read as XML. Vertex cells contribute IDs and labels; HTML formatting is removed while text and bracketed glob tags are retained. Edges use source and target attributes. Explicitly disabled arrows are ignored, start arrows reverse the source and target direction, and two active arrows create reciprocal policy edges. Compressed Draw.io page payloads are inflated with Node's built-in zlib support and capped at five MiB after expansion. Draw.io SVG files can contain XML in an SVG content attribute or encoded XML.

XML DTD and entity declarations are rejected. Diagram input is limited to five MiB by the detector. Unsupported formats, malformed files, and empty graphs become warning findings so users can repair the policy input.

## Import resolution and drift findings

Modified, added, and renamed source files are checked. Renames are evaluated at their new repository path so moving a file between mapped modules re-evaluates its ownership. For each import in those files, the detector maps the importer to one diagram node, resolves the target file, maps it to another node, and checks the directed edge. Existing imports in a modified file are checked too; enforcement is not limited to newly added import lines.

| Language | Import forms | Resolution |
| --- | --- | --- |
| JavaScript / TypeScript | Static imports, re-exports, require, dynamic import, and import-equals | TypeScript module resolution, including relative files and tsconfig paths aliases such as @/*. |
| Python | import, from ... import ..., parenthesized multiline imports, and relative imports | Dotted module paths and imported submodules map to .py modules and package __init__.py files in the repository; package symbols fall back to their containing module. |
| Go | Single and grouped import declarations | Imports under the repository go.mod module path map to source files in the imported package directory. |

External packages are ignored by architecture boundaries. If an import is likely internal but cannot resolve, or its importer or target has no unique node mapping, the detector emits a warning rather than inventing an edge. An internal cross-node import with no directed edge emits an error at the import line. The message names both nodes and files, the policy diagram, and the source node's allowed outgoing dependencies.

An arrow is directional: Billing --> Shared permits Billing to import Shared. It does not permit Shared to import Billing. A same-node import does not require an edge.

## Live drift diagram

**Intent Contract: Export Architecture Drift Diagram** runs the active check, writes **.intent/.architecture-drift.mmd**, and opens a Markdown preview containing the Mermaid graph. Official dependencies are drawn solid green. Illegal code imports are drawn dashed red with a VIOLATION label and cross arrow. Re-running the command refreshes the generated file and preview.

The generated report is ignored by .intent/.gitignore so it does not become a task change or trigger a scope warning. The source policy diagram remains authoritative; the exported diagram shows that policy plus current code violations.

## Extension, CLI, and MCP

All three integrations call the same runtime and workspace detector pipeline:

- The **extension** starts a baseline session and watches for file changes. Findings appear in the Explorer view, editor diagnostics, and status bar. Its export command reuses the active contract and baseline.
- The **CLI** can check an active session or an explicit base and contract. An error finding returns exit code 1. GitHub format produces CI annotations.
- The **MCP server** uses stdio JSON-RPC. verify_intent_contract calls the same runtime check, so architecture errors are returned in findings and make passed false.

The CLI and MCP are bundled as independent Node entry points. The extension bundle externalizes the VS Code API. The diagram parser does not use a third-party parsing library.

## Tests and maintenance

The full Vitest suite includes Phase 5 coverage for flowchart node/glob/edge parsing, C4 relationships, Markdown anchors, Draw.io XML and SVG parsing, compressed pages, architecture boundaries and exact import lines, Python and Go resolution, export styling, and CLI/MCP enforcement. Earlier phases cover contract validation, Git snapshots and diffs, scope rules, dependency and high-risk detectors, test weakening, agent configuration, and MCP request behavior.

The TypeScript typecheck validates the source project. The build type-checks, bundles the extension/CLI/MCP entries, and creates the installable VSIX.
