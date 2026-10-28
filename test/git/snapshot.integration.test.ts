import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diffTrees } from "../../src/git/diff";
import { revertFileToBaseline } from "../../src/git/revert";
import { captureBaseline, createWorkingTreeSnapshot, updateContractInBaseline } from "../../src/git/snapshot";

const temporaryRepositories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRepositories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("temporary index baseline", () => {
  it("captures and compares ignored files covered by read-only policy", async () => {
    vi.spyOn(os, "tmpdir").mockReturnValue(process.cwd());
    const root = await fs.mkdtemp(path.join(os.tmpdir(), ".intent-contract-readonly-test-"));
    temporaryRepositories.push(root);
    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Intent Contract Test"]);
    git(root, ["config", "user.email", "intent-test@example.invalid"]);
    await fs.writeFile(path.join(root, ".gitignore"), "locked.txt\n");
    await fs.writeFile(path.join(root, "locked.txt"), "baseline\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-m", "baseline"]);

    const baseline = await createWorkingTreeSnapshot(root, ["locked.txt"]);
    await fs.writeFile(path.join(root, "locked.txt"), "changed\n");
    const current = await createWorkingTreeSnapshot(root, ["locked.txt"]);
    const diff = await diffTrees(root, baseline, current);

    expect(diff.changes).toContainEqual(expect.objectContaining({ file: "locked.txt", status: "M" }));

    await fs.unlink(path.join(root, "locked.txt"));
    const afterDelete = await createWorkingTreeSnapshot(root, ["locked.txt"]);
    const deletionDiff = await diffTrees(root, baseline, afterDelete);
    expect(deletionDiff.changes).toContainEqual(expect.objectContaining({ file: "locked.txt", status: "D" }));
  });

  it("compares only post-baseline edits and reverts a file without changing the real index", async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), ".intent-contract-test-"));
    temporaryRepositories.push(root);
    vi.spyOn(os, "tmpdir").mockReturnValue(process.cwd());
    git(root, ["init"]);
    git(root, ["config", "user.name", "Intent Contract Test"]);
    git(root, ["config", "user.email", "intent-test@example.invalid"]);
    await fs.writeFile(path.join(root, "tracked.txt"), "committed\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "initial"]);

    await fs.writeFile(path.join(root, "tracked.txt"), "staged content\n");
    git(root, ["add", "tracked.txt"]);
    await fs.writeFile(path.join(root, "tracked.txt"), "baseline working tree\n");
    await fs.writeFile(path.join(root, "preexisting.txt"), "already here\n");
    await fs.writeFile(path.join(root, "rename-source.txt"), "rename baseline\n");

    const stagedBlobBefore = git(root, ["rev-parse", ":tracked.txt"]).trim();
    const snapshot = await captureBaseline(root);
    const baseline = snapshot.baselineTreeHash;
    expect(snapshot.headSha).toBe(git(root, ["rev-parse", "HEAD"]).trim());
    expect(snapshot.baselineRef.startsWith("refs/intent-contract/baselines/")).toBe(true);
    expect(git(root, ["rev-parse", ":tracked.txt"]).trim()).toBe(stagedBlobBefore);

    await fs.writeFile(path.join(root, "tracked.txt"), "agent edit\n");
    await fs.writeFile(path.join(root, "new.txt"), "new untracked file\n");
    await fs.rename(path.join(root, "rename-source.txt"), path.join(root, "rename-target.txt"));
    const current = await createWorkingTreeSnapshot(root);
    const diff = await diffTrees(root, baseline, current);
    expect(diff.changes.map((change) => change.file).sort()).toEqual(["new.txt", "rename-target.txt", "tracked.txt"]);

    const trackedChange = diff.changes.find((change) => change.file === "tracked.txt");
    const newChange = diff.changes.find((change) => change.file === "new.txt");
    const renameChange = diff.changes.find((change) => change.file === "rename-target.txt");
    if (!trackedChange || !newChange || !renameChange) throw new Error("Expected modified, added, and renamed changes in the diff.");
    expect(renameChange.status).toBe("R");
    await revertFileToBaseline(root, baseline, trackedChange);
    await revertFileToBaseline(root, baseline, newChange);
    await revertFileToBaseline(root, baseline, renameChange);

    expect(await fs.readFile(path.join(root, "tracked.txt"), "utf8")).toBe("baseline working tree\n");
    await expect(fs.access(path.join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(root, "rename-source.txt"), "utf8")).toBe("rename baseline\n");
    await expect(fs.access(path.join(root, "rename-target.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(root, "preexisting.txt"), "utf8")).toBe("already here\n");
    expect(git(root, ["rev-parse", ":tracked.txt"]).trim()).toBe(stagedBlobBefore);
  });

  it("updates contract in baseline tree without modifying other files", async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), ".intent-contract-update-test-"));
    temporaryRepositories.push(root);
    vi.spyOn(os, "tmpdir").mockReturnValue(process.cwd());
    git(root, ["init"]);
    git(root, ["config", "user.name", "Intent Contract Test"]);
    git(root, ["config", "user.email", "intent-test@example.invalid"]);

    await fs.mkdir(path.join(root, ".intent"), { recursive: true });
    await fs.writeFile(path.join(root, ".intent", "task.yaml"), "name: task\nscope:\n  modify: [src/**]\n");
    await fs.writeFile(path.join(root, "app.ts"), "const initial = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "initial"]);

    const snapshot = await captureBaseline(root);
    const initialTree = snapshot.baselineTreeHash;

    // Now hash a new contract content
    const updatedContent = "name: task\nscope:\n  modify: [src/**, lib/**]\n  modify_symbols: [helperFunc]\n";
    const blobSha = git(root, ["hash-object", "-w", "--stdin"], { input: updatedContent }).trim();

    const newTree = await updateContractInBaseline(root, initialTree, ".intent/task.yaml", blobSha);
    expect(newTree).not.toBe(initialTree);

    // Verify contract in new tree matches updated content
    const catBlob = git(root, ["cat-file", "blob", `${newTree}:.intent/task.yaml`]);
    expect(catBlob).toBe(updatedContent);

    // Verify app.ts in new tree is untouched
    const catApp = git(root, ["cat-file", "blob", `${newTree}:app.ts`]);
    expect(catApp).toBe("const initial = 1;\n");
  });
});

function git(root: string, args: string[], options: { input?: string } = {}): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    input: options.input
  });
}
