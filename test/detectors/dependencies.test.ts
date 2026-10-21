import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectDependencies } from "../../src/detectors/dependencies";
import type { Contract, FileChange } from "../../src/detectors/types";
import { parseUnifiedDiff } from "../../src/git/diff";

const fixtureDirectory = path.resolve(__dirname, "../fixtures");
const contract: Contract = {
  name: "deps",
  intent: "No new dependencies",
  scope: { modify: ["**"], read_only: [] },
  forbid: ["new_dependencies"],
  allow_exceptions: true
};

describe("dependency detector", () => {
  it("reports an added npm dependency by package name", () => {
    const parsed = parseUnifiedDiff("M\0package.json\0", fs.readFileSync(path.join(fixtureDirectory, "dependency-added.diff"), "utf8"));
    const change = {
      ...parsed.changes[0],
      beforeContent: "{\n  \"name\": \"sample\",\n  \"scripts\": { \"test\": \"vitest\" }\n}\n",
      afterContent: "{\n  \"name\": \"sample\",\n  \"dependencies\": {\n    \"left-pad\": \"^1.3.0\"\n  },\n  \"scripts\": { \"test\": \"vitest\" }\n}\n"
    };
    const findings = detectDependencies([change], contract);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "error", message: "New dependency added: left-pad" });
  });

  it("reports a Python package added to requirements.txt", () => {
    const change = manifestChange("requirements.txt", "requests==2.31.0\n", "requests==2.31.0\nhttpx>=0.27\n");
    expect(detectDependencies([change], contract)).toMatchObject([
      { severity: "error", file: "requirements.txt", message: "New dependency added: httpx" }
    ]);
  });

  it("reports a devDependency version change", () => {
    const change = manifestChange("package.json", "{\"devDependencies\":{\"vitest\":\"^2.0.0\"}}", "{\"devDependencies\":{\"vitest\":\"^2.1.0\"}}");
    expect(detectDependencies([change], contract)).toMatchObject([
      { severity: "error", evidence: expect.stringContaining("vitest: ^2.0.0 -> ^2.1.0") }
    ]);
  });

  it("reports added packages in pyproject.toml, Pipfile, go.mod, and Cargo.toml", () => {
    const pyproject = manifestChange(
      "pyproject.toml",
      "[project]\ndependencies = [\n  \"requests>=2\",\n]\n",
      "[project]\ndependencies = [\n  \"requests>=2\",\n  \"httpx>=0.27\",\n]\n"
    );
    const pipfile = manifestChange("Pipfile", "[packages]\nrequests = \"*\"\n", "[packages]\nrequests = \"*\"\nhttpx = \"*\"\n");
    const goMod = manifestChange(
      "go.mod",
      "module example.com/app\n\nrequire (\n\tgithub.com/acme/old v1.0.0\n)\n",
      "module example.com/app\n\nrequire (\n\tgithub.com/acme/old v1.0.0\n\tgolang.org/x/text v0.3.0\n)\n"
    );
    const cargo = manifestChange("Cargo.toml", "[dependencies]\nserde = \"1.0\"\n", "[dependencies]\nserde = \"1.0\"\nregex = \"1.10\"\n");
    const findings = detectDependencies([pyproject, pipfile, goMod, cargo], contract);
    expect(findings.map((finding) => finding.message).sort()).toEqual([
      "New dependency added: golang.org/x/text",
      "New dependency added: httpx",
      "New dependency added: httpx",
      "New dependency added: regex"
    ]);
  });

  it("does not flag a package.json scripts-only edit", () => {
    const change = manifestChange("package.json", "{\"scripts\":{\"test\":\"vitest run\"}}", "{\"scripts\":{\"test\":\"vitest\"}}");
    expect(detectDependencies([change], contract)).toEqual([]);
  });

  it("flags a lockfile-only change as an error", () => {
    const parsed = parseUnifiedDiff("M\0package-lock.json\0", fs.readFileSync(path.join(fixtureDirectory, "lockfile-only.diff"), "utf8"));
    expect(detectDependencies(parsed.changes, contract)).toMatchObject([
      { severity: "error", detector: "dependencies", file: "package-lock.json" }
    ]);
  });

  it("continues to flag a lockfile renamed out of its lockfile name", () => {
    const rename: FileChange = {
      status: "R",
      file: "package-lock.json.bak",
      oldFile: "package-lock.json",
      newFile: "package-lock.json.bak",
      additions: [],
      deletions: [],
      binary: false
    };
    expect(detectDependencies([rename], contract)).toContainEqual(
      expect.objectContaining({ file: "package-lock.json", severity: "error" })
    );
  });

  it("warns on a lockfile changed with its manifest", () => {
    const manifest = manifestChange("package.json", "{\"dependencies\":{}}", "{\"dependencies\":{\"left-pad\":\"1.0.0\"}}");
    const lock = { ...manifestChange("package-lock.json", "{}", "{\"lockfileVersion\":3}"), file: "package-lock.json" };
    const findings = detectDependencies([manifest, lock], contract);
    expect(findings).toContainEqual(expect.objectContaining({ severity: "error", file: "package.json" }));
    expect(findings).toContainEqual(expect.objectContaining({ severity: "warning", file: "package-lock.json" }));
  });
});

function manifestChange(file: string, beforeContent: string, afterContent: string): FileChange {
  return {
    status: "M",
    file,
    oldFile: file,
    newFile: file,
    additions: [],
    deletions: [],
    binary: false,
    beforeContent,
    afterContent
  };
}
