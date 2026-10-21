const assert = require("node:assert/strict");
const vscode = require("vscode");

exports.run = async function runSmoke() {
  const extension = vscode.extensions.getExtension("intent-contract.intent-contract");
  assert.ok(extension, "The Intent Contract extension should be available in the extension host.");
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "intentContract.start",
    "intentContract.stop",
    "intentContract.recheck",
    "intentContract.copyViolations",
    "intentContract.revertFile",
    "intentContract.waiveFinding",
    "intentContract.exportArchitectureDrift"
  ]) {
    assert.ok(commands.includes(command), `Expected command ${command} to be registered.`);
  }
};
