# Welcome to Intent Contract

### The Safety Harness for AI-Assisted "Vibe Coding"

In the modern AI coding era, developers prompt autonomous agents—such as **Cursor**, **Claude Code**, **GitHub Copilot**, and **Google Antigravity**—to build features at lightspeed. You describe intent in natural language, and the agent modifies dozens of files in seconds.

However, autonomous agents introduce critical failure modes that standard linters and CI pipelines fail to catch:

- **Silent Scope Creep**: The agent modifies files outside the assigned task, touches shared utilities, or alters build scripts.
- **Test Weakening ("Faking Green")**: The agent "fixes" failing tests by deleting assertions, changing `.toBe()` to `.toBeTruthy()`, widening tolerances, or adding `.skip()`.
- **Supply-Chain Hallucinations**: The agent adds unapproved npm, PyPI, or Go packages or introduces dangerous lifecycle scripts.
- **Architecture Erosion**: The agent takes shortcuts by importing directly from private internal packages or databases instead of established domain boundaries.

Intent Contract locks a pristine Git baseline, evaluates changes in the background, and gives you real-time non-blocking diagnostics and one-click reverts.

[Open Vibe Coding Guide](command:intentContract.openGuide)
