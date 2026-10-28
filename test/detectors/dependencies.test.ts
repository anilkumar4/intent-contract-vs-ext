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

  it("editing package.json does not re-report EXISTING dependencies as new", () => {
    const before = JSON.stringify({ name: "app", description: "old desc", dependencies: { lodash: "^4.17.21" } }, null, 2);
    const after = JSON.stringify({ name: "app", description: "new desc", dependencies: { lodash: "^4.17.21" } }, null, 2);
    const change = manifestChange("package.json", before, after);
    expect(detectDependencies([change], contract)).toEqual([]);
  });

  it("reports a version bump as 'Dependency version changed' with old -> new", () => {
    const before = JSON.stringify({ dependencies: { lodash: "^4.17.20" } }, null, 2);
    const after = JSON.stringify({ dependencies: { lodash: "^4.17.21" } }, null, 2);
    const change = manifestChange("package.json", before, after);
    const findings = detectDependencies([change], contract);
    expect(findings).toContainEqual(
      expect.objectContaining({
        detector: "dependencies",
        message: expect.stringMatching(/Dependency version changed: lodash/),
        evidence: expect.stringContaining("lodash: ^4.17.20 -> ^4.17.21")
      })
    );
  });

  it("removing a dependency does not flag the remaining ones", () => {
    const before = JSON.stringify({ dependencies: { lodash: "^4.17.21", vitest: "^2.0.0" } }, null, 2);
    const after = JSON.stringify({ dependencies: { vitest: "^2.0.0" } }, null, 2);
    const change = manifestChange("package.json", before, after);
    expect(detectDependencies([change], contract)).toEqual([]);
  });

  it("pip / pyproject / go.mod: pre-existing entries are not re-reported when the file is edited", () => {
    const pipBefore = "requests==2.31.0\n";
    const pipAfter = "requests==2.31.0\nflask==3.0.0\n";
    const pipChange = manifestChange("requirements.txt", pipBefore, pipAfter);
    const pipFindings = detectDependencies([pipChange], contract);
    expect(pipFindings.map((f) => f.message)).toEqual(["New dependency added: flask"]);

    const goBefore = "module example.com/app\n\nrequire (\n\tgithub.com/google/uuid v1.3.0\n)\n";
    const goAfter = "module example.com/app\n\nrequire (\n\tgithub.com/google/uuid v1.3.0\n\tgithub.com/stretchr/testify v1.8.4\n)\n";
    const goChange = manifestChange("go.mod", goBefore, goAfter);
    const goFindings = detectDependencies([goChange], contract);
    expect(goFindings.map((f) => f.message)).toEqual(["New dependency added: github.com/stretchr/testify"]);
  });

  it("detects npm lifecycle scripts (postinstall) as supply-chain risk", () => {
    const before = JSON.stringify({ scripts: { build: "tsc" } }, null, 2);
    const after = JSON.stringify({ scripts: { build: "tsc", postinstall: "node ./setup.js" } }, null, 2);
    const change = manifestChange("package.json", before, after);
    const findings = detectDependencies([change], contract);
    expect(findings).toContainEqual(
      expect.objectContaining({
        detector: "dependencies",
        message: expect.stringContaining("postinstall script")
      })
    );
  });

  it("detects npm overrides and yarn resolutions", () => {
    const before = JSON.stringify({ dependencies: { express: "4.18.2" } }, null, 2);
    const after = JSON.stringify({ dependencies: { express: "4.18.2" }, overrides: { minimist: "^1.2.6" } }, null, 2);
    const change = manifestChange("package.json", before, after);
    const findings = detectDependencies([change], contract);
    expect(findings).toContainEqual(
      expect.objectContaining({
        detector: "dependencies",
        message: expect.stringContaining("minimist")
      })
    );
  });

  it("detects go.mod replace directives", () => {
    const before = "module example.com/app\n\nrequire example.com/foo v1.0.0\n";
    const after = "module example.com/app\n\nrequire example.com/foo v1.0.0\nreplace example.com/foo => example.com/fork v1.0.1\n";
    const change = manifestChange("go.mod", before, after);
    const findings = detectDependencies([change], contract);
    expect(findings).toContainEqual(
      expect.objectContaining({
        detector: "dependencies",
        message: expect.stringContaining("replace directive")
      })
    );
  });

  it("detects Maven (pom.xml), Gradle (build.gradle.kts), .NET (.csproj), and Ruby (Gemfile) additions", () => {
    const pom = manifestChange("pom.xml", "<project></project>", "<project><dependencies><dependency><groupId>org.junit</groupId><artifactId>junit</artifactId><version>4.13</version></dependency></dependencies></project>");
    const gradle = manifestChange("build.gradle.kts", "dependencies {}", "dependencies {\n  implementation(\"org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.0\")\n}");
    const csproj = manifestChange("app.csproj", "<Project></Project>", "<Project><ItemGroup><PackageReference Include=\"Newtonsoft.Json\" Version=\"13.0.3\" /></ItemGroup></Project>");
    const gemfile = manifestChange("Gemfile", "source \"https://rubygems.org\"", "source \"https://rubygems.org\"\ngem \"rails\", \"~> 7.0\"\n");

    const findings = detectDependencies([pom, gradle, csproj, gemfile], contract);
    expect(findings).toHaveLength(4);
    expect(findings.every((f) => f.detector === "dependencies")).toBe(true);
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
