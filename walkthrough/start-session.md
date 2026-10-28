# Start Session & Lock Baseline

### Cryptographic Baseline Snapshot in Git

When you start an Intent Contract session:

1. **Snapshot Captured**: An ephemeral Git tree object is captured using an isolated index file (`GIT_INDEX_FILE`). Your working directory and real staging index are left untouched.
2. **Rules Locked**: The contract is read directly from the captured Git baseline ref. The agent cannot bypass rules mid-session by altering `.intent/` files.
3. **Sub-Second Monitoring**: The engine verifies workspace changes in the background on every keystroke (~600–900 ms latency).

Ready to begin?

[Start Contract Session](command:intentContract.start)

