# Intent Contract

Intent Contract captures a local Git tree as a task baseline and detects changes that violate a contract in `.intent/*.yaml`. It reports changes after they are written and provides a baseline restore action. It does not block writes. The active contract is read from the captured baseline; stop and start again to activate contract edits.

## Contract example

```yaml
name: fix-proration
intent: Fix proration rounding in billing
scope:
  modify: ["billing/**"]
  read_only: ["shared/**"]
forbid:
  - new_dependencies
  - high_risk_files
allow_exceptions: true
```

Contracts are validated when loaded. Read-only paths are errors; other paths outside `scope.modify` are warnings. Phase 1 detects dependency additions or version changes and edits to high-risk CI, environment, Docker, Terraform, agent configuration, and lock files.

## Run the extension

1. Run `npm install` in this project.
2. Open the project folder in VS Code or Cursor.
3. Press F5 and choose **Run Intent Contract Extension**.
4. In the Extension Development Host, open a local Git repository.
5. Run **Intent Contract: Create Contract From Template**, edit `.intent/default.yaml` for the task, then run **Intent Contract: Start Contract**.

The extension host must support the VS Code `extensionHost` debug configuration. If a fork does not offer that debug type, package with `npm run build` and install `intent-contract.vsix` using its **Install from VSIX** command.

## Commands and baseline

- **Start Contract** captures the current working tree, including uncommitted and untracked files, using a temporary Git index. The actual index is left untouched.
- **Re-check Now** compares the current tree with that snapshot. File-system changes and editor saves also trigger a check after about 800 ms.
- **Revert File to Baseline** restores one changed file or removes one file that was added after the baseline.
- **Waive Finding** records a required reason and timestamp in `.intent/waivers.json` when the contract allows exceptions.
- **Copy Violations For Agent** copies active findings as corrective instructions. `.intent/.violations.md` is also refreshed on each check.
- **Stop Contract** ends the active session.

The Explorer view groups findings by file, provides diff/revert/waive actions, and keeps waived findings in a separate group. Diagnostics appear at a changed line when available or at the start of a file for file-level findings.

## Development checks

- `npm test` runs contract, detector, diff parsing, and Git snapshot/revert tests.
- `npm run test:smoke` runs a minimal VS Code extension-host startup test. It uses an installed `code` executable when available; otherwise `@vscode/test-electron` downloads VS Code.
- `npm run build` type-checks, bundles with esbuild, and packages `intent-contract.vsix`.

Test weakening, mutation checks, natural-language contract drafting, and symbol-level scope are reserved for later phases.
