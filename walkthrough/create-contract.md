# Define Your Task Contract

### Set the Guardrails Before Prompting Your Agent

Before starting an AI coding session, declare the task boundary in `.intent/<feature>.yaml` or build it visually:

- **Task Intent**: High-level natural language description of what you are building.
- **Allowed Scope (`scope.modify`)**: Glob patterns for files the agent is permitted to touch (e.g. `src/billing/**`, `test/billing/**`).
- **Read-Only Scope (`scope.read_only`)**: Explicitly protected files (e.g. `src/billing/db.ts`, `secrets/**`).
- **Allowed Symbols (`scope.modify_symbols`)**: Specific function or method names the agent is allowed to edit. Edits to local variables inside these functions are permitted; other top-level symbols produce errors.
- **Forbidden Risks**:
  - `test_weakening`: Forbids assertion drops, matcher downgrades, and skipped tests.
  - `new_dependencies`: Forbids adding unapproved packages.
  - `high_risk_files`: Forbids modifying CI/CD workflows, Dockerfiles, and secrets.
  - `architecture_drift`: Enforces Mermaid (`.mmd`) or Draw.io (`.drawio`) boundaries.

You never have to hand-code YAML. Use the built-in **Visual Contract Builder**:

[Open Visual Contract Builder](command:intentContract.visualBuilder)

