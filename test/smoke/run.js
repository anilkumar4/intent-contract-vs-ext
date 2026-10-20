const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { runTests } = require("@vscode/test-electron");

function findVSCodeExecutable() {
  if (process.env.VSCODE_EXECUTABLE && fs.existsSync(process.env.VSCODE_EXECUTABLE)) {
    return process.env.VSCODE_EXECUTABLE;
  }
  if (process.platform === "win32") {
    try {
      const cliPath = execFileSync("where.exe", ["code.cmd"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)[0].trim();
      const executable = path.resolve(path.dirname(cliPath), "..", "Code.exe");
      if (fs.existsSync(executable)) return executable;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "intent-contract-smoke-"));
  try {
    const vscodeExecutablePath = findVSCodeExecutable();
    const exitCode = await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, "../.."),
      extensionTestsPath: path.resolve(__dirname, "suite.js"),
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
      launchArgs: [workspace, "--disable-workspace-trust"]
    });
    if (exitCode !== 0) throw new Error(`VS Code extension smoke test exited with status ${exitCode}.`);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
