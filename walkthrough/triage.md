# Monitor, Revert & Push

### Real-Time Triage & Observability in Your Workspace

As your AI agent writes code:

- **Mission Control Dashboard**: Live radar scorecards across scope, tests, dependencies, and architecture, with 1-click corrective agent prompts.
- **Architecture Drift Inspector**: Interactive Mermaid diagram with green allowed edges, red dashed cross-import violation arrows, and 1-click "Jump to Line" navigation.
- **Problems Panel & In-Editor Squiggles**: Violations appear with exact line attribution and remediation advice (e.g. `[test_weakening/assertion_loss] Net assertion count dropped by 2`).
- **Interactive Quick-Fixes (`Ctrl+.`)**: Add files to scope or revert with native VS Code quick actions.
- **Ambient CodeLens**: Non-intrusive status pills at line 1 (`In-Scope`, `Read-Only`, `Out of Scope`).
- **Activity Bar Panel**: Inspect active violations grouped by file.
- **Diff with Baseline**: Right-click any file to see side-by-side changes against the pristine baseline snapshot.
- **Revert File to Baseline**: Instantly roll back agent hallucinations or unwanted modifications without touching git history.
- **Add Waiver**: For intentional exceptions, record a tamper-evident audit waiver with smart justification templates.
- **Session Compliance Report**: Generate an audit certificate with cryptographic Git seals.
- **Guarded Push**: `git push` is verified by the `pre-push` hook, ensuring broken or unapproved changes never reach remote branches.

[Open Mission Control Dashboard](command:intentContract.openDashboard)

[Open Intent Contract Sidebar](command:workbench.view.extension.intent-contract-sidebar)

