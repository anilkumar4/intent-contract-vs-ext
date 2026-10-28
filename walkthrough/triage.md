# Monitor, Revert & Push

### Real-Time Triage in Your Workspace

As your AI agent writes code:

- **Problems Panel & Squiggles**: Violations appear with exact line attribution and remediation advice (e.g. `[test_weakening/assertion_loss] Net assertion count dropped by 2`).
- **Activity Bar Panel**: Inspect active violations grouped by file.
- **Diff with Baseline**: Right-click any file to see side-by-side changes against the pristine baseline snapshot.
- **Revert File to Baseline**: Instantly roll back agent hallucinations or unwanted modifications without touching git history.
- **Add Waiver**: For intentional exceptions, record a tamper-evident audit waiver (when `allow_exceptions: true`).
- **Guarded Push**: `git push` is verified by the `pre-push` hook, ensuring broken or unapproved changes never reach remote branches.

[Open Intent Contract Sidebar](command:workbench.view.extension.intent-contract-sidebar)
