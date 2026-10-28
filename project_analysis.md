# Intent Contract — Complete Project Analysis

## Executive Summary

**Intent Contract** is a VS Code extension (+ CLI + MCP server) that acts as a **policy enforcement guardrail for AI-assisted coding**. It captures a Git working tree as a frozen baseline, then continuously detects when file changes violate a YAML-defined "contract" — scope boundaries, forbidden dependency additions, high-risk file edits, test weakening, and architectural drift. It reports violations *after* writes (non-blocking), provides one-click revert to baseline, and feeds structured remediation instructions to AI agents so they can self-correct.

> [!IMPORTANT]
> The key design philosophy: **a code change cannot approve itself**. The contract and architecture diagram are always read from the captured baseline tree, not the working copy, so an AI agent can't weaken its own rules.

---

## Architecture Overview

```mermaid
flowchart LR
  subgraph "Three Delivery Surfaces"
    EXT["VS Code Extension<br/>src/extension.ts"]
    CLI["CLI<br/>src/cli/index.ts"]
    MCP["MCP Server<br/>src/mcp/server.ts"]
  end

  subgraph "Shared Core"
    CONTRACT["Contract Layer<br/>schema · loader · template"]
    DETECTORS["Detector Pipeline<br/>scope · deps · highRisk<br/>symbolScope · testWeakening<br/>tautologicalTests · archDrift"]
    GIT["Git Layer<br/>cli · snapshot · diff · revert"]
    RUNTIME["Runtime<br/>contracts.ts"]
    STATE["State<br/>session · waivers · violations"]
    ARCH["Architecture<br/>diagramParser"]
  end

  subgraph "UI Components"
    TREE["Activity Bar & Tree View"]
    DIAG["Diagnostics"]
    SB["Status Bar HUD"]
    DASH["Mission Control Dashboard"]
    ARCH_UI["Visual Architecture Inspector"]
    BUILDER["Visual Contract Builder"]
    CODELENS["Ambient Scope CodeLens"]
    QUICKFIX["Quick-Fix CodeActions"]
    ACTIONS["Actions & Scope Helpers"]
    BASELINE["Baseline Provider"]
  end

  EXT --> CONTRACT
  EXT --> DETECTORS
  EXT --> GIT
  EXT --> STATE
  CLI --> RUNTIME
  MCP --> RUNTIME
  RUNTIME --> CONTRACT
  RUNTIME --> DETECTORS
  RUNTIME --> GIT
  RUNTIME --> STATE
  DETECTORS --> ARCH
  EXT --> TREE & DIAG & SB & ACTIONS & BASELINE
```

---

## Module-by-Module Breakdown

### 1. Contract Layer — `src/contract/`

| File | Purpose |
|------|---------|
| [`schema.ts`](src/contract/schema.ts) | **Zod schema** defining the contract shape: `name`, `intent`, `scope` (modify/read_only/modify_symbols), `architecture` (`diagram`, `node_mappings`, `default_policy`), `forbid` enum array, and `allow_exceptions`. Custom refinement enforces that `architecture_drift` in `forbid` requires an `architecture` block. |
| [`loader.ts`](src/contract/loader.ts) | Discovers `.intent/*.yaml` files, reads and parses YAML, validates against the Zod schema. `parseContract()` is also used to parse contracts from Git blob buffers. |
| [`template.ts`](src/contract/template.ts) | Creates a default `default.yaml` template and ensures `.intent/.gitignore` ignores transient metadata files (`.state.json`, `.violations.md`, `waivers.json`, `.architecture-drift.mmd`). |

### 2. Detector Pipeline — `src/detectors/`

The heart of the system. Seven independent detectors run in a pipeline, each returning `Finding[]`:

| Detector | File | What It Catches | Severity |
|----------|------|-----------------|----------|
| **Scope** | [`scope.ts`](src/detectors/scope.ts) | Files outside `scope.modify` (warning) or in `scope.read_only` (error) | error/warning |
| **Symbol Scope** | [`symbolScope.ts`](src/detectors/symbolScope.ts) | Changes to function/variable symbols *not* in `scope.modify_symbols`. Uses a lightweight JS/Python parser that masks comments/strings, then matches diff lines to symbol ranges. | error |
| **Dependencies** | [`dependencies.ts`](src/detectors/dependencies.ts) | New dependencies or version changes in `package.json`, `pyproject.toml`, `Pipfile`, `go.mod`, `Cargo.toml`, `requirements*.txt`. Also detects unpaired lockfile changes. Full before/after manifest diffing. | error/warning |
| **High Risk Files** | [`highRisk.ts`](src/detectors/highRisk.ts) | Changes to CI workflows, `.env`, Dockerfiles, Terraform, agent config, lockfiles | error |
| **Test Weakening** | [`testWeakening.ts`](src/detectors/testWeakening.ts) | **The most sophisticated detector** (~900 lines). Implements a full tokenizer and assertion parser for JS/Python. Detects: deleted test files, snapshot deletions, net test block loss, net assertion loss, disabled tests (`.skip`, `.only`, `pytest.mark.skip`, etc.), trivially-true assertions, matcher downgrades (Tier 1→2→3), assertion negation flips, tolerance widening (`toBeCloseTo` precision / `pytest.approx` rel), expected value changes coinciding with implementation changes, inline snapshot changes, empty test blocks. | error/warning |
| **Tautological Tests** | [`tautologicalTests.ts`](src/detectors/tautologicalTests.ts) | Assertion-free test blocks and self-mocking (asserting a value returned by a mock you configured in the same test) | error |
| **Architecture Drift** | [`architectureDrift.ts`](src/detectors/architectureDrift.ts) | Import statements in changed files that violate the architecture diagram's directed dependency graph. Supports JS/TS, Python, Go, Java, Kotlin, and C#; diagram is read from the policy baseline. | error/warning |

**Finding identity**: Each finding gets a SHA-256-based `id` derived from `[detector, file, rule, evidence]`, making it deterministic and waivable.

### 3. Architecture Diagram Parser — `src/architecture/diagramParser.ts`

| Format | Support |
|--------|---------|
| **Mermaid** `.mmd` | `flowchart`/`graph` with all arrow types (`-->`, `-.->`, `==>`, bidirectional `<-->`) and C4 (`Container`, `Rel`, `BiRel`) |
| **Markdown** `.md#anchor` | Finds fenced `mermaid` code blocks, optionally scoped to a `#heading` anchor |
| **Draw.io** `.drawio`, `.dio` | Full XML parsing of `mxCell` vertices and edges with arrow direction from styles, supports compressed/deflated diagram payloads |
| **Draw.io SVG** `.drawio.svg` | Extracts embedded Draw.io XML from SVG attributes or HTML-entity-encoded content |

Node labels can embed `[glob/patterns/**]` to auto-map architecture nodes to file paths.

### 4. Git Layer — `src/git/`

| File | Purpose |
|------|---------|
| [`cli.ts`](src/git/cli.ts) | Thin async wrapper over `git` CLI (`execFile`). Two variants: `gitText()` for UTF-8, `gitBuffer()` for raw buffers. 64 MiB max buffer. |
| [`snapshot.ts`](src/git/snapshot.ts) | **Baseline capture**: uses an isolated temporary index and `git write-tree` without changing the real index. Captures untracked and unstaged files, selected ignored secret/high-risk paths, and ignored paths matched by `scope.read_only`. Also builds candidate trees from the staged index or a pushed commit. Creates refs under `refs/intent-contract/baselines/` to prevent GC. |
| [`diff.ts`](src/git/diff.ts) | Runs `git diff-tree` (name-status) + `git diff` (unified patch), parses both into `FileChange[]` with structured `DiffHunk[]`, and enriches each change with full before/after file content via `git cat-file`. |
| [`revert.ts`](src/git/revert.ts) | Restores individual files from the baseline tree hash. Handles renames, additions (delete added file), modifications, and symlinks. **Security-hardened**: validates parent directories against symlink traversal. |

### 5. VS Code Extension — `src/extension.ts`

The main entry point. Lifecycle:

1. **activate()**: Registers 20 commands, dedicated Activity Bar container, tree views, diagnostics collection, CodeLens provider, QuickFix CodeAction provider, content providers, file watcher, dynamic agent hot-sync, and restores any saved session.
2. **File watcher**: Debounces FS events (create/change/delete) and editor saves with a configurable 300ms timer (`intentContract.debounce`) → `runCheck()`.
3. **runCheck()**: Serialized via `checkRunning`/`checkQueued` flags to avoid overlapping checks. Calls `performCheck()` which:
   - Creates a fresh working-tree snapshot
   - Diffs baseline vs. current
   - Runs all detectors
   - Reads waivers, filters active findings
   - Updates diagnostics, tree view, status bar HUD, CodeLens, and `.violations.md`
4. **startContract()**: Discovers/picks a contract, captures baseline, loads contract from baseline tree, persists session, and hot-syncs agent rules.
5. **Metadata**: `.intent/.state.json`, `.intent/.violations.md`, `.intent/waivers.json`, `.intent/reports/`, and the exported drift diagram are ignored by Git metadata rules; contract files and architecture diagrams remain part of the policy tree.

### 6. UI Components — `src/ui/`

| Component | File | Description |
|-----------|------|-------------|
| **Activity Bar & Tree View** | [`treeView.ts`](src/ui/treeView.ts) | Dedicated Activity Bar view container `intent-contract-sidebar` grouping findings by file, with session status overview and "Waived Findings" collapsible group. |
| **Mission Control Dashboard** | [`dashboard.ts`](src/ui/dashboard.ts) | Full interactive webview panel with real-time scorecards across 4 safety dimensions, 1-click corrective agent prompts, bulk out-of-scope reverts, session controls, and compliance report exports. |
| **Visual Architecture Inspector** | [`architectureInspector.ts`](src/ui/architectureInspector.ts) | Visual diagram explorer rendering the baseline architecture diagram overlaid with live compliance edges (green allowed, red dashed cross-import violations) with 1-click "Jump to Line" and "Revert" actions. |
| **Visual Contract Builder** | [`visualBuilder.ts`](src/ui/visualBuilder.ts) | Interactive form webview to configure task contracts, scan workspace directories, extract AST symbols from active files, and generate AI task prompts without writing raw YAML. |
| **Ambient Scope CodeLens** | [`codeLens.ts`](src/ui/codeLens.ts) | Non-intrusive status indicators at line 1 of active files (`🛡️ Intent: In-Scope`, `🔒 Intent: Read-Only`, `⚠️ Intent: Out of Scope`) with 1-click quick action buttons. |
| **Quick-Fix CodeActions** | [`quickFix.ts`](src/ui/quickFix.ts) | Native VS Code QuickFix (`Ctrl+.` / 💡) actions on active diagnostics to add files to scope, revert to baseline, add symbols to modify scope, or inspect in architecture visualizer. |
| **Diagnostics** | [`diagnostics.ts`](src/ui/diagnostics.ts) | Maps findings to VS Code diagnostic collection with error/warning severity squiggles at the relevant line. |
| **Status Bar HUD** | [`statusBar.ts`](src/ui/statusBar.ts) & [`extension.ts`](src/extension.ts) | Left-aligned item showing `$(shield) Contract: name · N violations`. Clicking launches an interactive command HUD for starting/ending sessions, dashboard navigation, reports, and switching contracts. |
| **Scope & Context Helpers** | [`scopeHelpers.ts`](src/ui/scopeHelpers.ts) | Right-click editor and explorer actions (`Add Symbol to Scope`, `Add File to Scope`, `Mark File Read-Only`) with live Git baseline sync (`updateContractInBaseline`). |
| **Baseline Provider** | [`baselineContentProvider.ts`](src/ui/baselineContentProvider.ts) | `intent-baseline://` URI scheme providing baseline file content for VS Code diff views. |
| **Actions & Smart Waivers** | [`actions.ts`](src/ui/actions.ts) | `openDiff()`, `revertFile()` (with modal confirmation), `waiveFinding()` (with smart templates & TTL duration picker), `copyFindingsForAgent()`. |

### 7. State Management — `src/state/`

| File | Format | Purpose |
|------|--------|---------|
| [`session.ts`](src/state/session.ts) | `.intent/.state.json` | Persists `baselineTreeHash`, `originalBaselineTreeHash`, optional `originalBaselineRef`, `headSha`, `startedAt`, `baselineRef`, and `activeContract`. Survives VS Code restarts. |
| [`waivers.ts`](src/state/waivers.ts) | `.intent/waivers.json` | Array of `{id, reason, timestamp, expires_at?}`. Implements time-to-live (TTL) expiration; expired waivers automatically re-open findings. |
| [`violations.ts`](src/state/violations.ts) | `.intent/.violations.md` | Refreshed on every check; markdown formatted for agent consumption. |
| [`formatViolations.ts`](src/state/formatViolations.ts) | — | Formats findings as structured remediation instructions with diff evidence and action items. |
| [`report.ts`](src/state/report.ts) | `.intent/reports/*.md` | Generates verified Markdown AI Safety certificates, vector SVG badges, and GitHub/GitLab PR comments with cryptographic Git audit seals. |

### 8. Runtime — `src/runtime/contracts.ts`

Headless operations shared by CLI and MCP (no VS Code dependency):
- `getActiveContract()` — read session + parse contract from baseline
- `verifyIntentContract()` — full check cycle with `{passed, findings, remediationInstructions}`
- `startIntentContract()` / `stopIntentContract()` — session lifecycle
- `revertOutOfScopeFiles()` — bulk revert of scope-violating files
- `revertIntentFile()` — single file revert

### 9. CLI — `src/cli/index.ts`

Commands: `start <name> [--force]`, `check [--base --contract --index --revision --format]`, `report [--output <path>] [--badge <path>] [--pr-comment <path>]`, `revert <file>`, `hook install`, `guide`, `stop`.
- `--index` checks staged content; `--revision <sha>` checks a local commit tree. They cannot be combined and require an active session.
- `--base origin/main` uses a Git ref as the policy tree (for CI without active sessions).
- `--format github` outputs `::error file=...,line=...::message` annotations.
- `report [--output <path>] [--badge <path>] [--pr-comment <path>]` exports AI safety compliance certificates, SVG badges, and PR comments.
- Automatically appends rich Markdown compliance reports and summary banners to `$GITHUB_STEP_SUMMARY` when running in GitHub Actions CI runners.
- Exit code 1 on unwaived error findings.

### 10. MCP Server — `src/mcp/server.ts`

JSON-RPC over stdio implementing MCP protocol (version `2024-11-05`). Six tools:

| Tool | Description |
|------|-------------|
| `get_active_contract` | Returns contract YAML, parsed fields, boundaries |
| `verify_intent_contract` | Full verification with findings + remediation text |
| `get_remediation_instructions` | Step-by-step actionable instructions for autonomous agent self-correction |
| `revert_out_of_scope_files` | Restore scope-violating files to baseline |
| `self_heal_contract` | Autonomous agent remediation loop that reverts out-of-scope files and re-verifies |
| `start_intent_contract` | Start a named contract by name |

### 11. Agent Configuration & Hot-Sync — `src/config/agentConfig.ts` & `src/config/agentSync.ts`

One-click setup and dynamic session hot-sync for four AI agent ecosystems plus the Git hooks:

| Integration | MCP Config | Rules File | Hot-Sync Support |
|-------------|-----------|------------|:----------------:|
| **Cursor** | `.cursor/mcp.json` | `.cursor/rules/intent-contract.mdc` | ✅ Auto-injected on start, cleaned on stop |
| **Google Antigravity** | `.agents/mcp_config.json` | `.agents/rules/intent-contract.md` | ✅ Auto-injected on start, cleaned on stop |
| **Claude Code** | `.mcp.json` | `CLAUDE.md` (appended) | ✅ Auto-injected on start, cleaned on stop |
| **GitHub Copilot** | `.vscode/mcp.json` (`servers`) | `.github/copilot-instructions.md` (appended) | ✅ Auto-injected on start, cleaned on stop |
| **Git pre-commit** | — | `.git/hooks/pre-commit` checks `--index` (shell block) | Permanent hook |
| **Git pre-push** | — | `.git/hooks/pre-push` checks each pushed local SHA with `--revision` (shell block) | Permanent hook |

All merge non-destructively using `<!-- BEGIN/END INTENT CONTRACT GENERATED RULE -->` markers.

---

## Build & Toolchain

| Aspect | Detail |
|--------|--------|
| **Language** | TypeScript (strict mode, ES2022 target) |
| **Bundler** | esbuild → 3 CJS bundles: `dist/extension.js`, `dist/cli.js`, `dist/mcp-server.js` |
| **Testing** | Vitest (unit) + `@vscode/test-electron` (smoke) |
| **Dependencies** | Only 3 runtime deps: `picomatch` (glob matching), `yaml` (YAML parsing), `zod` (schema validation) |
| **Package** | `vsce package` → `intent-contract.vsix` (3.3 MB) |
| **Node version** | 22.12+ required |

---

## Contract YAML Schema

```yaml
name: string             # required, min 1 char
intent: string            # human description of the task
scope:
  modify: [glob, ...]     # files the task MAY change
  read_only: [glob, ...]  # files that MUST NOT change
  modify_symbols: [name, ...]  # optional: only these functions/variables may be touched
architecture:             # optional, required if forbid includes architecture_drift
  diagram: "path.mmd"    # Mermaid, Markdown, or Draw.io
  node_mappings:          # maps diagram nodes → file globs
    NodeName: ["glob/**"]
  default_policy: "deny_unlisted_edges"  # only value supported
forbid:                   # list of detector toggles
  - new_dependencies
  - test_weakening
  - high_risk_files
  - architecture_drift
allow_exceptions: true    # enables waiver workflow
```

---

## Data Flow

```mermaid
sequenceDiagram
    participant User as User/Agent
    participant FS as File System
    participant Ext as Extension
    participant Git as Git CLI
    participant Det as Detectors

    User->>Ext: Start Contract
    Ext->>Git: captureBaseline() → tree hash
    Ext->>Git: Store ref to prevent GC
    Ext-->>User: "Started contract X"

    loop On file change (800ms debounce)
        FS-->>Ext: FileSystemWatcher event
        Ext->>Git: createWorkingTreeSnapshot()
        Ext->>Git: diffTrees(baseline, current)
        Git-->>Ext: ParsedDiff with FileChange[]
        Ext->>Det: detectFindingsForWorkspace()
        Det-->>Ext: Finding[]
        Ext->>Ext: Filter waivers, update UI
        Ext->>FS: Write .violations.md
    end

    User->>Ext: Revert File
    Ext->>Git: cat-file blob → restore bytes
```

---

## Security & Integrity Design

1. **Policy immutability**: Contracts and architecture diagrams are read from the effective policy tree, not the working tree. Waivers are separate mutable records and are ignored when the baseline contract sets `allow_exceptions: false`.
2. **Path traversal protection**: `resolveRepoFile()` and `revertFileToBaseline()` reject `..` segments and absolute paths. Symlink traversal is blocked during revert.
3. **Symlink safety**: Revert refuses to write through symlinked parent directories.
4. **Agent config safety**: `assertRegularFileOrMissing()` refuses to overwrite symlinks when configuring agent integrations.
5. **Finding determinism**: SHA-256 IDs are derived from `[detector, file, rule, evidence]` — deterministic across checks.

---

## File Statistics

| Directory | Files | Lines of TypeScript |
|-----------|-------|-------------------|
| `src/contract/` | 3 | ~134 |
| `src/detectors/` | 12 | ~2,200 |
| `src/architecture/` | 1 | ~426 |
| `src/git/` | 4 | ~312 |
| `src/ui/` | 5 | ~306 |
| `src/state/` | 4 | ~165 |
| `src/runtime/` | 1 | ~170 |
| `src/mcp/` | 1 | ~184 |
| `src/cli/` | 1 | ~145 |
| `src/config/` | 1 | ~183 |
| `src/util/` | 2 | ~26 |
| `src/extension.ts` | 1 | ~403 |
| **Total** | **36** | **~4,654** |

---

## Test Coverage

Tests live in `test/` and cover:
- Contract schema validation (`test/contract.test.ts`)
- Detector-specific tests (`test/detectors/`)
- Git diff parsing (`test/git/`)
- MCP server (`test/mcp/`)
- CLI (`test/cli/`)
- Agent config (`test/config/`)
- Test fixtures (`test/fixtures/`)
- VS Code smoke test (`test/smoke/`)

---

## Key Design Patterns

1. **Non-blocking observation**: The extension watches but never blocks writes. It's a *post-hoc* auditor.
2. **Debounced check loop**: 800ms debounce on FS events, serialized via `checkRunning` flag to avoid concurrent Git operations.
3. **Three surfaces, one core**: Extension, CLI, and MCP server all share `runtime/contracts.ts` and the detector pipeline.
4. **Tiered assertion analysis**: Test weakening uses a 3-tier model (exact → partial → existence) to detect matcher downgrades.
5. **Disposable pattern**: All VS Code resources implement `Disposable` and are registered in `context.subscriptions`.
6. **Zod-first validation**: Contract schema validation happens at load time with precise error messages.

---

## Potential Improvement Areas

> [!NOTE]
> These are observations, not criticisms. The codebase is well-structured and production-ready.

1. **Duplicated `isMissing()` helper**: Appears in 7+ files — could be extracted to `util/errors.ts`.
2. **Duplicated `errorMessage()` helper**: Same pattern across multiple files.
3. **Duplicated `Token`/`tokenize` implementations**: Both `testWeakening.ts` and `tautologicalTests.ts` have independent tokenizers — could share a common tokenizer module.
4. **`detectors/types.ts` vs `contract/schema.ts`**: The `Contract` type is defined in both places (Zod-inferred in `schema.ts`, manually in `types.ts`). They're compatible but could be unified.
5. **Large file risk**: `testWeakening.ts` is 901 lines — some of the sub-detectors (tolerance widening, matcher downgrades) could be extracted into separate files.
6. **No language detection beyond extension**: Symbol scope and architecture drift rely solely on file extensions for language detection.
