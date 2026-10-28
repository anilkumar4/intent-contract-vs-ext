# Changelog

All notable changes to the **Intent Contract** extension, CLI, and MCP server are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.3.0] - 2026-10-28

### Added
- **Sub-Second Diagnostic Latency**:
  - Reduced default debounce from 800 ms to 300 ms (`intentContract.debounce`).
  - Cached repository `.git/index` path resolution to eliminate redundant `git rev-parse` subprocesses.
  - Pathspec-filtered ignored file scans that skip massive directories like `node_modules`, `dist`, and `.vscode-test`, cutting `git status` scan time from ~600 ms to ~75 ms.
  - Parallelized `git diff-tree` and `git diff` execution in `diffTrees()` via `Promise.all` with a 0 ms fast exit when tree hashes match.
  - Session cache guard in `performCheck()` to prevent unnecessary Git ref verification on routine keystrokes.
  - End-to-end check latency is now **~600–900 ms** (well below the 1.5-second target).
- **Stable MCP Launcher**:
  - Implemented `ensureStableMcpLauncher()` in `src/config/agentConfig.ts`.
  - Generated MCP server entrypoints now create a durable, unversioned proxy launcher at `.vscode/extensions/anilkumar4.intent-contract/dist/mcp-server.js`.
  - At runtime, the launcher dynamically inspects `.vscode/extensions/` for the latest installed version and delegates execution, completely surviving extension upgrades without `MODULE_NOT_FOUND`.
- **Git Staging & Push Verification**:
  - Added `--index` flag to `intent-contract check` for verifying candidate trees staged in the Git index.
  - Added `--revision <sha>` flag to `intent-contract check` for verifying exact commit trees being pushed.
  - `pre-commit` hook automatically checks `--index`.
  - `pre-push` hook reads Git stdin stream (`local_ref local_sha remote_ref remote_sha`) and checks each non-zero local commit SHA with `--revision`, blocking unauthorized code before it leaves the developer's workstation.
  - Added `materializeTree()` for isolated candidate checkouts without modifying the workspace or real Git index.
- **Enterprise 5-Column Architecture Diagram**:
  - Redesigned `docs/intent-contract-architecture.drawio` with clean orthogonal routing, strict directional swimlanes, and zero overlapping lines or crossed connectors.
- **Vibe Coding Best Practices Guide**:
  - Added comprehensive guide in `docs/vibe-coding-guide.md` and root `README.md` overview detailing how Intent Contract guards developers against scope creep, test weakening, supply-chain risks, and architecture drift when vibe coding with Cursor, Claude Code, GitHub Copilot, and Google Antigravity.

### Fixed
- **Symbol-Scope Local Variable Attribution**:
  - Fixed regression in `src/detectors/symbolScope.ts` where changing local variables (e.g., `ratio` inside `prorate()`) was mistakenly attributed to a new symbol instead of the enclosing function.
  - Restructured `topVarPattern` to strictly match top-level declarations (at brace depth 0 outside any function or method range).
- **Strict Exception Enforcement**:
  - Bypassed persisted waivers in `waivers.json` when the baseline contract sets `allow_exceptions: false` across all CLI and MCP verification tools.
- **Re-baselining Protection**:
  - Guarded `startIntentContract` to reject restarts while a session is active unless explicit `--force` is supplied. Old baseline references are preserved until replacement baselines are safely persisted.
- **Dependency Security Audit**:
  - Updated `zod` to `^4.6.7` and added `@azure/msal-node: 7.1.2` override, resolving all vulnerabilities (0 vulnerabilities reported by `npm audit`).

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

