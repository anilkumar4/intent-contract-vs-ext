# Intent Contract

Intent Contract captures a local Git tree as a task baseline and detects changes that violate a contract in `.intent/*.yaml`. It reports changes after they are written and provides a baseline restore action. It does not block writes. The active contract is read from the captured baseline; stop and start again to activate contract edits.

## Why "Vibe Coding" Needs Intent Contract

In the modern **Vibe Coding** era, developers prompt autonomous agents—such as **Cursor**, **Claude Code**, **GitHub Copilot**, and **Google Antigravity**—to build features at lightspeed. You describe what you want in natural language, and the agent writes dozens of files in seconds.

However, autonomous agents introduce critical failure modes that standard linters and CI pipelines fail to catch:

| Vibe Coding Risk | What AI Agents Frequently Do | How Intent Contract Protects You |
|---|---|---|
| **Silent Scope Creep** | The agent touches files outside the prompt's domain, edits configs, or modifies shared utility functions. | Flags any modification outside `scope.modify` or inside `scope.read_only`. Restricts changes down to specific AST function/method symbols via `scope.modify_symbols`. |
| **Test Weakening ("Faking Green")** | When a test fails, the agent "fixes" it by changing `.toBe()` to `.toBeTruthy()`, widening numeric tolerances, or adding `.skip()`. | The Test Weakening detector catches net assertion loss, matcher downgrades, `@Disabled`/`t.Skip()`, and tautological tests instantly. |
| **Supply-Chain Hallucinations** | The agent hallucinates or imports arbitrary npm/pip/Go packages or adds dangerous `postinstall` scripts. | Flags unauthorized dependencies, unpaired lockfile updates, and supply-chain risk scripts across 8 package ecosystems. |
| **Architecture Erosion** | The agent bypasses architectural layers (e.g. billing module importing directly from database instead of shared service). | Evaluates codebase imports against your Mermaid or Draw.io architecture diagrams from baseline Git snapshots. |
| **Self-Approval Loopholes** | The agent tries to bypass restrictions by editing the contract file or adding fake waivers. | Policies are locked in Git's baseline tree object. Changes to `.intent/**` are treated as errors, and waivers are tamper-evident. |
| **Accidental Bad Pushes** | Hallucinated code or weakened tests get pushed to remote branches before anyone notices. | The `pre-push` Git hook verifies the exact commit SHA being pushed and aborts the push if active violations exist. |

See the complete [Vibe Coding Best Practices Guide](https://github.com/anilkumar4/intent-contract-vs-ext/blob/master/docs/vibe-coding-guide.md) for workflow tutorials and agent setups.

## Contract example

```yaml
name: fix-proration
intent: Fix proration rounding in billing
scope:
  modify: ["billing/**"]
  read_only: ["shared/**"]
architecture:
  diagram: "docs/system.mmd"
  node_mappings:
    Billing: ["billing/**"]
    Shared: ["shared/**"]
  default_policy: "deny_unlisted_edges"
forbid:
  - new_dependencies
  - high_risk_files
  - architecture_drift
allow_exceptions: true
```

Contracts are validated when loaded. Read-only paths are errors; other paths outside `scope.modify` are warnings. Phase 1 detects dependency additions or version changes and edits to high-risk CI, environment, Docker, Terraform, agent configuration, and lock files.

When architecture_drift is enabled, directed arrows define permitted module dependencies. The contract and diagram are read from the policy baseline so a code change cannot approve itself by changing its rules or adding an arrow. Mermaid flowcharts and C4 blocks are supported in .mmd files and fenced blocks in Markdown; use README.md#architecture to select a heading section. Draw.io .drawio, .dio, and .drawio.svg files are also supported. JavaScript and TypeScript, Python, Go, Java, Kotlin, and C# imports are checked in modified, added, or renamed files, including existing imports in those changed files. Unmapped or unresolved internal paths produce warnings.

## Run the extension

1. Run `npm install` in this project.
2. Open the project folder in VS Code or Cursor.
3. Press F5 and choose **Run Intent Contract Extension**.
4. In the Extension Development Host, open a local Git repository.
5. Run **Intent Contract: Create Contract From Template**, edit `.intent/default.yaml` for the task, then run **Intent Contract: Start Contract**.

The extension host must support the VS Code `extensionHost` debug configuration. If a fork does not offer that debug type, package with `npm run build` and install `intent-contract.vsix` using its **Install from VSIX** command.

## Commands and baseline

- **Dedicated Activity Bar Container**: Access all sessions, active findings, and waived items from the dedicated Shield icon on the primary Activity Bar.
- **Native Getting Started Walkthrough**: 5-step interactive onboarding walkthrough integrated natively into VS Code's Welcome experience to guide new developers through task boundary definition, agent connection, and safe pushing.
- **Open Mission Control Dashboard**: Launches the interactive mission control webview with real-time health scorecards across scope, tests, dependencies, and architecture, with 1-click corrective prompt generation, out-of-scope reverts, and compliance report exporting.
- **View Architecture Drift Inspector**: Renders an interactive Mermaid diagram overlay with green allowed edges, highlighted red violation arrows, breach details table, and direct "Jump to Line" action buttons.
- **Visual Contract Builder**: Creates task contracts interactively via a form webview without hand-editing YAML, including workspace folder discovery and active editor symbol extraction.
- **Interactive Quick-Fix CodeActions**: Hover over squiggles or press `Ctrl+.` / `Cmd+.` (💡) on diagnostics to instantly add files to scope, revert changes back to baseline, or add functions to `scope.modify_symbols`.
- **Interactive Status Bar HUD**: Click the `$(shield)` item in the status bar to launch a command HUD for quick session controls, dashboard navigation, reports, and contract switching.
- **Session Compliance Report**: Exports an enterprise-grade AI safety audit certificate in `.intent/reports/compliance-report-<timestamp>.md` with a 5-dimension scorecard, modified files ledger, and cryptographic Git audit seal.
- **Ambient In-Editor CodeLens**: Shows non-intrusive status indicators at line 1 of files during active sessions (`🛡️ Intent: In-Scope`, `🔒 Intent: Read-Only`, `⚠️ Intent: Out of Scope`) with 1-click quick actions.
- **In-Editor Scope Helpers**: Right-click context actions (`Add Symbol to Active Scope`, `Add File to Active Scope`, `Mark File as Read-Only`) with live Git baseline synchronization.
- **Dynamic Agent Prompt Hot-Sync**: Automatically injects active contract constraints into Cursor, Claude Code, GitHub Copilot, and Google Antigravity rule files during active sessions.
- **Smart Waiver Justification Templates**: 1-click QuickPick justification templates (`Authorized refactoring`, `Approved scope extension`, `Approved dependency update`, etc.) for seamless developer waivers.
- **Configure AI Agents & MCP**: Adds the local stdio MCP server and agent instructions to selected Cursor, Antigravity, Claude Code, GitHub Copilot, and Git pre-commit and pre-push hook configurations.
- **Open Vibe Coding Guide**: Opens the comprehensive best practices guide inside VS Code in markdown preview or via the $(book) icon in the Intent Contract Findings panel.
- **Git Push & Commit Blocking**: Installing the Git hooks automatically verifies active contracts on `git commit` and `git push`, blocking pushes and commits whenever error findings exist until they are resolved or authorized waivers are recorded.
- **Export Architecture Drift Diagram**: Writes **.intent/.architecture-drift.mmd** for the active architecture contract and opens a Mermaid Markdown preview. Official edges are green; unlisted code imports are dashed red and labeled as violations.
- **Start Contract**: Captures the current working tree, including uncommitted and untracked files, using a temporary Git index. The actual index is left untouched.
- An active session cannot be replaced accidentally. Stop it before starting another contract, or use `intent-contract start <name> --force` to capture a deliberate replacement baseline.
- **Re-check Now**: Compares the current tree with that snapshot. File-system changes and editor saves also trigger a check after the configured debounce interval.
- **Revert File to Baseline**: Restores one changed file or removes one file that was added after the baseline.
- **Waive Finding**: Records a required reason and timestamp in `.intent/waivers.json` when the contract allows exceptions.
- **Copy Violations For Agent**: Copies active findings as corrective instructions. `.intent/.violations.md` is also refreshed on each check.
- **Stop Contract**: Ends the active session.

The Explorer view groups findings by file, provides diff/revert/waive actions, and keeps waived findings in a separate group. Diagnostics appear at a changed line when available or at the start of a file for file-level findings.

## CLI and MCP

The build produces `dist/cli.js` and `dist/mcp-server.js` alongside the VS Code extension bundle. The CLI does not require an active extension session when a Git base and contract are supplied. Run from the repository root:

    node dist/cli.js start default [--force]
    node dist/cli.js check [--base origin/main] [--contract .intent/default.yaml] [--format text|json|github]
    node dist/cli.js check --index
    node dist/cli.js check --revision <local-commit-sha>
    node dist/cli.js report [--output <path>] [--badge <path>] [--pr-comment <path>]
    node dist/cli.js revert src/example.ts
    node dist/cli.js hook install
    node dist/cli.js guide
    node dist/cli.js stop

The CLI reads the contract from the same policy tree it checks: the selected `--base`, the active session baseline, or `HEAD`. The contract path must exist in that tree. This keeps a change from weakening its own policy during a check. `check --index` verifies the staged Git index; `check --revision <sha>` verifies a local commit tree, as used by the pre-push hook. The check command returns exit code 1 when unwaived error findings exist. Formats are text, json, and GitHub Actions annotations.

When running in GitHub Actions CI workflows, setting `$GITHUB_STEP_SUMMARY` automatically causes both `intent-contract check` and `intent-contract report` to render rich Markdown compliance scorecards and violation tables directly in the GitHub Actions run summary tab.

The MCP server uses JSON-RPC over stdio and exposes `get_active_contract`, `verify_intent_contract`, `get_remediation_instructions`, `revert_out_of_scope_files`, `self_heal_contract`, and `start_intent_contract`.

## Development checks

Use Node.js 22.12 or newer for installing dependencies, running tests, and packaging the VSIX.

- `npm test` runs contract, detector, diff parsing, and Git snapshot/revert tests.
- `npm run test:smoke` runs a minimal VS Code extension-host startup test. It uses an installed `code` executable when available; otherwise `@vscode/test-electron` downloads VS Code.
- `npm run build` type-checks, bundles with esbuild, and packages `intent-contract.vsix`.

Test weakening, tautological-test detection, and symbol-level scope are included in the detector pipeline.

## Project architecture

See [the editable Draw.io architecture diagram](https://github.com/anilkumar4/intent-contract-vs-ext/blob/master/docs/intent-contract-architecture.drawio) and [the detailed architecture guide](https://github.com/anilkumar4/intent-contract-vs-ext/blob/master/docs/intent-contract-architecture.md) for module responsibilities, baseline and verification flows, architecture parsing, import resolution, and the extension/CLI/MCP integration.
