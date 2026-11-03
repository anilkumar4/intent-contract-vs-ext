# How to Investigate Incoming User Issues

A comprehensive guide for maintainers and contributors on triaging, reproducing, and resolving issues reported by users of **Intent Contract** (VS Code extension, headless CLI, and MCP server).

---

## 📋 Standard Debugging Checklist

When a user submits an issue via GitHub Issues, VS Code Command Palette (`Intent Contract: Report an Issue`), or community channels, follow this step-by-step checklist:

### 1. 🔍 Check the Version
- **Action**: Verify the version of Intent Contract the user is running.
- **Why**: Many reported quirks or transient behaviors in earlier releases (such as `0.4.1`, `0.4.2`, or `0.4.3`) have already been resolved in subsequent releases (e.g., `0.4.4` and `0.4.5`).
- **Resolution**:
  - Ask the user to verify via the VS Code Extensions panel or status bar.
  - If they are on an older version, ask them to upgrade to the latest marketplace release (`v0.4.5+`) and check if the issue persists.

---

### 2. 📜 Inspect the Contract YAML
- **Action**: Review the user's `.intent/*.yaml` contract rules (ensure they provide a sanitized version without proprietary paths or secrets).
- **Key Areas to Check**:
  - `scope.modify`: Are their file glob patterns matching the intended files? (Note: uses standard minimatch/picomatch syntax).
  - `scope.read_only`: Are any files unintentionally matched by read-only rules or wildcards (e.g. `src/shared/**`)?
  - `scope.modify_symbols`: For TypeScript/JavaScript files, are AST symbols (functions, methods, classes) correctly spelled?
  - `forbid`: Check which active detectors are enabled (`test_weakening`, `dependencies`, `high_risk_files`, `architecture_drift`).
  - `allow_exceptions`: If waivers aren't suppressing findings, check whether `allow_exceptions: false` is configured (which intentionally disallows all waivers).

---

### 3. 🖥️ Reproduce via CLI (Isolate Engine vs UI)
- **Action**: Run the headless CLI in a clean reproduction repository or workspace to isolate whether the issue originates in the detector engine / Git snapshot logic or in the VS Code webview/diagnostic UI.
- **Commands**:
  ```bash
  # Check working tree against active baseline
  npx intent-contract check --debug

  # Check with explicit contract path
  npx intent-contract check --contract .intent/task.yaml

  # Check staged Git index (same check run by pre-commit hook)
  npx intent-contract check --index

  # Check specific commit SHA (same check run by pre-push hook)
  npx intent-contract check --revision <commit-sha>
  ```
- **CLI Exit Codes**:
  - `0`: All checks passed (or only non-blocking warnings present).
  - `1`: Contract violation detected (error severity findings).
  - `2`: Invocation / CLI syntax / configuration error.

---

### 4. 🗄️ Inspect Git Baseline & Session State
- **Action**: If the user reports that baselines are lost, sessions won't start/stop, or Git operations fail, inspect the `.intent/` directory and Git reference hierarchy:
  ```bash
  # Check active session JSON state
  cat .intent/.state.json

  # Inspect active baseline references in Git
  git for-each-ref refs/intent-contract/baselines/

  # Check Git index and repository status
  git status --porcelain=v1 -z -uall
  ```
- **Self-Healing Features (v0.4.5+)**:
  - `ensurePolicyBaselineRef`: Automatically validates and re-pins missing baseline references in Git before any check runs, protecting trees against `git gc`.
  - Atomic Locks: Concurrency conflicts are automatically queued via `.git/intent-contract.lock` (with 120 retry attempts / ~6 seconds timeout and Windows `EBUSY`/`EPERM` resilience).
  - Dead Session Recovery: If a baseline tree was purged by manual Git garbage collection, Intent Contract cleanly cleans up the dead session and provides actionable recovery guidance instead of crashing with exit code 2.

---

### 5. 🧪 Run the Regression Test Suite
- **Action**: Run the full automated test suite to ensure the environment is healthy and verify existing contracts:
  ```bash
  # Typecheck TypeScript codebase
  npm run typecheck

  # Run full Vitest suite (140+ unit & integration tests)
  npm test

  # Run specific detector test file
  npx vitest run test/detectors/scope.test.ts
  npx vitest run test/detectors/architectureDrift.test.ts
  ```

---

### 6. 🛡️ Add Regression Test & Patch
- **Action**: Once the issue is reproduced:
  1. Add a reproduction test case in [test/ui/defectsRegression.test.ts](../test/ui/defectsRegression.test.ts) or in the respective detector test suite (`test/detectors/`).
  2. Implement the minimal compliant fix in `src/`.
  3. Ensure `npm run typecheck` and `npm test` pass with 100% success.
  4. Document the fix under `CHANGELOG.md` with appropriate issue number or defect ID.

---

## 🛠️ Common Issue Categories & Quick Diagnostic Commands

| Issue Category | Common Cause | Quick Diagnostic Command |
| :--- | :--- | :--- |
| **False Positive Scope Warning** | Unmatched negative pattern or missing glob wildcard | Check path with `matchesPatterns(file, patterns)` in Vitest |
| **False Test Weakening Error** | Net assertion count reduced or tolerance widened (`pytest.approx`) | Check `testWeakening.ts` matcher diffs |
| **Architecture Drift Warning** | Cross-module import added not drawn in `.mmd` / `.drawio` | Run `intent-contract check --debug` to view node mappings |
| **Git Commit / Push Blocked** | Active error findings exist in staged index or outgoing revision | Run `intent-contract check --index` or inspect VS Code diagnostics |
| **Waiver Expired** | Waiver TTL has lapsed (`expires_at < now`) | Inspect `.intent/waivers.json` timestamps |
| **Activity Bar Icon Distortion** | Theme color alpha-mask flattening | Verify `media/activitybar.svg` uses `currentColor` strokes |
| **Windows Lock Error** | Another process holding Git index file | Verified handled by transient retry exponential backoff |

---

## 📞 Escalation & Issue Tracker Links

- **GitHub Issues**: [github.com/anilkumar4/intent-contract-vs-ext/issues](https://github.com/anilkumar4/intent-contract-vs-ext/issues)
- **Discussions & Q&A**: [github.com/anilkumar4/intent-contract-vs-ext/discussions](https://github.com/anilkumar4/intent-contract-vs-ext/discussions)
- **Marketplace Q&A**: [marketplace.visualstudio.com/items?itemName=anilkumar4.intent-contract](https://marketplace.visualstudio.com/items?itemName=anilkumar4.intent-contract)
