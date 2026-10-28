# Connect Your AI Agent & MCP

### One-Click Rules & Autonomous Self-Verification

Intent Contract integrates directly with all major AI assistants:

- **Cursor**: Generates `.cursor/rules/intent-contract.mdc` so Cursor's agent always checks boundaries.
- **Claude Code**: Appends contract guidelines to `CLAUDE.md`.
- **GitHub Copilot**: Configures `.github/copilot-instructions.md`.
- **Google Antigravity**: Configures `.agents/rules/intent-contract.md`.
- **Model Context Protocol (MCP)**: Persistent JSON-RPC stdio server (`mcp-server.js`) that allows agents to inspect contract rules and revert their own out-of-scope files.
- **Git Hooks**: Installs `pre-commit` and `pre-push` hooks that verify the exact commit SHA being pushed and abort pushes if active violations exist.

[Configure AI Agents & Hooks](command:intentContract.configureAgents)
