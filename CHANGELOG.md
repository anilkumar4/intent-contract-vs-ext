# Changelog

All notable changes to the **Intent Contract** extension, CLI, and MCP server are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.3.0] - 2026-10-28

### Added
- **Sub-Second Diagnostic Latency**:
  - Reduced default diagnostic debounce from 800 ms to 300 ms (`intentContract.debounce`).
  - Optimized file change detection to skip large un-tracked directories like `node_modules` and build outputs, cutting status scan times by over 80%.
  - Parallelized Git tree comparison engine with fast-exit optimizations for unchanged trees.
  - Overall end-to-end contract verification latency is now **~600–900 ms** (well below the 1.5-second target).
- **Resilient MCP Server Configuration**:
  - Generated Model Context Protocol (MCP) server configurations now survive extension updates without breaking or pointing to stale versioned folders.
  - Automatically maintains backward compatibility across extension upgrades.
- **Git Staging & Push Guardrails**:
  - Added `--index` flag to `intent-contract check` for verifying candidate changes staged in the Git index prior to commit.
  - Added `--revision <commit-sha>` flag to `intent-contract check` for verifying exact commits during Git push operations.
  - Enhanced `pre-commit` hook to automatically check staged index changes.
  - Enhanced `pre-push` hook to verify each commit SHA being pushed to remote branches, blocking unauthorized changes or weakened tests from leaving the local machine.
- **Enterprise Architecture Diagrams**:
  - Clean 5-column orthogonal layout design for system architecture diagrams with clear directional swimlanes and module boundaries.
- **Vibe Coding Best Practices Guide**:
  - Comprehensive guide and workflow documentation detailing how Intent Contract guards developers against silent scope creep, test weakening ("faking green"), supply-chain hallucinations, and architecture erosion when pairing with autonomous AI agents (Cursor, Claude Code, GitHub Copilot, and Google Antigravity).
- **Dedicated Activity Bar Container**:
  - Elevated Intent Contract to a dedicated, first-class view container on the primary Activity Bar (left sidebar) with quick session controls and findings management.
- **Interactive Visual Contract Builder**:
  - Built-in visual contract creator webview (`Intent Contract: Visual Contract Builder`) that allows developers to define task boundaries, allowed file globs, symbol constraints, and forbidden risks without manually editing YAML. Includes automated workspace directory detection, active-editor symbol extraction, and 1-click AI task prompt generation.
- **Native Getting Started Walkthrough**:
  - 5-step interactive onboarding walkthrough integrated natively into VS Code's Welcome experience to guide new developers through task boundary definition, agent connection, and safe pushing.
- **Live Mission Control Dashboard (Option A)**:
  - Interactive webview panel (`Intent Contract: Open Mission Control Dashboard`) providing real-time health scorecards across Scope Adherence, Test Fidelity, Dependency Security, and Architectural Boundaries.
  - Generates 1-click corrective agent prompts with complete finding context and precise remediation guidance.
  - Direct controls for 1-click out-of-scope reverts, re-checking, stopping sessions, and launching the Visual Contract Builder.
- **Interactive Visual Architecture Drift Inspector (Option B)**:
  - Visual diagram explorer (`Intent Contract: View Architecture Drift Inspector`) rendering the baseline architecture diagram overlaid with live compliance edges.
  - Highlights allowed module links in green and renders offending cross-module imports as highlighted red dashed arrows.
  - Provides a breach triage table with direct "Jump to Line" editor navigation and "Revert" actions for offending imports.
- **In-Editor Symbol & Scope Helpers (Option C)**:
  - Context menu actions in editor and file explorer: `Intent Contract: Add Symbol to Active Scope`, `Intent Contract: Add File to Active Scope (Modify)`, and `Intent Contract: Mark File as Read-Only`.
  - Automatically updates `.intent/*.yaml` and dynamically synchronizes the active Git baseline tree so contract boundaries expand or contract without restarting sessions or losing baseline snapshots.
- **MCP 2.0 Autonomous Agent Self-Healing Tools (Option D)**:
  - Added `get_remediation_instructions` tool to provide structured, actionable step-by-step guidance for autonomous agents (Cursor, Claude Code, GitHub Copilot, Google Antigravity).
  - Added `self_heal_contract` tool for autonomous remediation, safely reverting out-of-scope file modifications while preserving valid in-scope progress.
- **Ambient In-Editor Scope CodeLens**:
  - Non-intrusive status indicators at line 1 of files during active sessions (`🛡️ Intent: In-Scope`, `🔒 Intent: Read-Only`, `⚠️ Intent: Out of Scope`) with 1-click quick actions to add to scope or lock as read-only.
  - Added `intentContract.enableCodeLens` configuration setting (enabled by default).
- **Dynamic Agent Prompt Hot-Sync Engine**:
  - Automatically syncs active task intent, permitted file globs, symbols, and forbidden policies into active agent instruction files (Cursor `.cursor/rules/`, Google Antigravity `.agents/rules/`, Claude Code `CLAUDE.md`, and GitHub Copilot `.github/copilot-instructions.md`).
  - Preserves user custom instructions outside managed comment blocks and cleans up automatically when sessions stop.
- **Full Architectural & UX Documentation Overhaul**:
  - Updated `docs/intent-contract-architecture.md` and `README.md` with complete architectural diagrams, UI layers, CodeLens mechanics, and MCP 2.0 autonomous agent correction loops.
- **Interactive Quick-Fix Code Actions (`src/ui/quickFix.ts`)**:
  - Native VS Code QuickFix (`Ctrl+.` / 💡) actions on active contract diagnostics to add files to scope, revert files to baseline, add symbols to modify scope, or inspect in the Architecture Inspector.
- **Interactive Status Bar HUD & Quick Switcher**:
  - Clicking the Status Bar shield opens a rich quick-action launcher with live session status, 1-click dashboard navigation, agent prompt copying, compliance report generation, manual recheck, and contract switching.
- **Session Audit & Compliance Report Generator (`src/state/report.ts`)**:
  - Added `Intent Contract: Export Session Compliance Report` (`intentContract.exportReport`).
  - Generates enterprise-ready compliance certificates in `.intent/reports/compliance-report-<timestamp>.md` with an AI Safety Scorecard across 5 dimensions, modified files ledger, and cryptographic Git audit seal.

### Fixed
- **Symbol Scope Attribution for Local Variables**:
  - Fixed an issue where modifying local variables inside an allowed function or method was incorrectly reported as an unauthorized symbol modification.
- **Strict Exception Enforcement**:
  - Ensured persisted waivers are strictly ignored when the active contract sets `allow_exceptions: false`, preventing unauthorized waiver bypasses across CLI and MCP tools.
- **Session Re-baselining Protection**:
  - Guarded active contract sessions against accidental restarts or re-baselining unless explicit `--force` is provided, preserving baseline audit integrity.
- **Dependency Security Audit**:
  - Updated dependencies and resolved all reported vulnerabilities (0 vulnerabilities).

---

## [0.2.0] - 2026-10-28

### Added
- **Security & Anti-Laundering**:
  - Added `originalBaselineTreeHash` tracking so agents cannot launder violations mid-session by restarting the contract.
  - Tamper-evident waivers with SHA-256 evidence hashes, required non-empty reasons, and ISO timestamps.
  - Implicit read-only protection for `.intent/**` policy files and referenced architecture diagrams.
  - Force-tracking of `.gitignore` secrets (`.env*`, `secrets/**`, `*.tfvars`) to catch unauthorized environment changes.
- **Multi-Language Coverage**:
  - TS AST symbol scoping for typed arrow functions, class methods, getters, and top-level constants.
  - Dependency manifest detection for Maven (`pom.xml`), Gradle (`build.gradle.kts`), .NET (`*.csproj`), and Ruby (`Gemfile`).
  - Detection of npm lifecycle scripts (`preinstall`/`postinstall`) and dependency overrides/resolutions.
  - Detection of test weakening: Python `pytest.approx` tolerance inflation, Go `t.Skip()`, and JUnit `@Disabled`.
  - Architecture drift resolution for Python `src/` layout, single-line Go imports, and Java/C#/Kotlin namespaces.
- **Packaging & UX**:
  - Lazy extension activation (`workspaceContains:.intent/`).
  - Configurable settings (`debounce`, `autoCheck`, `ignoredPaths`, `severityOverrides`).
  - VS Code Codicon icons for inline Findings tree actions (Diff, Waive, Revert).
  - MCP version negotiation according to MCP specification `2024-11-05`.

---

## [0.1.0] - 2026-10-21

### Added
- Initial release of Intent Contract.
- Real-time VS Code extension with diagnostics, findings tree, and status bar badge.
- Headless CLI (`intent-contract`) with `start`, `check`, `revert`, and `stop`.
- Model Context Protocol (MCP) server with JSON-RPC stdio transport.
- Git temporary index snapshot engine using `GIT_INDEX_FILE`.
- Zero-dependency Mermaid and Draw.io architecture diagram parser.

