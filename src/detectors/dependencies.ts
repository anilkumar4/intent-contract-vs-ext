import path from "node:path";
import type { Contract, Finding, FileChange } from "./types";
import { makeFinding } from "./finding";
import { changedLine, diffEvidence } from "./diffEvidence";

const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides", "resolutions"];
const lockfiles = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock",
  "poetry.lock", "Pipfile.lock", "Cargo.lock", "go.sum", "Gemfile.lock", "gradle.lockfile", "packages.lock.json"
]);

export function detectDependencies(changes: FileChange[], contract: Contract): Finding[] {
  if (!contract.forbid.includes("new_dependencies")) return [];
  const findings: Finding[] = [];
  const changedManifests = changes.filter((change) => changePaths(change).some(isManifest));

  for (const change of changedManifests) {
    const beforePath = change.oldFile ?? change.file;
    const afterPath = change.newFile ?? change.file;
    const before = extractDependencies(beforePath, change.beforeContent ?? "");
    const after = extractDependencies(afterPath, change.afterContent ?? "");
    const updated = [...after.entries()]
      .filter(([name, version]) => !before.has(name) || before.get(name) !== version)
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [name, version] of updated) {
      const oldVersion = before.get(name);
      const dependencyChange = oldVersion === undefined ? `${name}=${version}` : `${name}: ${oldVersion} -> ${version}`;
      const evidence = `${dependencyChange}\n${diffEvidence(change, name)}`;
      const line = changedLine(change, name);
      findings.push(makeFinding(
        "dependencies", afterPath, "dependency_changed", evidence, "error",
        oldVersion === undefined ? `New dependency added: ${name}` : `Dependency version changed: ${name}`,
        line,
        "Revert the dependency change unless it is required and explicitly approved; implement the requested behavior using the current dependency set."
      ));
    }
  }

  for (const change of changes) {
    for (const lockfile of changePaths(change).filter(isLockfile)) {
      const manifest = correspondingManifest(lockfile);
      const paired = manifest !== undefined && changedManifests.some((candidate) => changePaths(candidate).includes(manifest));
      const severity = paired ? "warning" : "error";
      const evidence = `${paired ? `lockfile changed with ${manifest}` : `lockfile changed without ${manifest ?? "a matching manifest"}`}\n${diffEvidence(change)}`;
      findings.push(makeFinding(
        "dependencies", lockfile, "lockfile_changed", evidence, severity,
        paired
          ? `Lockfile changed: ${path.posix.basename(lockfile)}`
          : `Lockfile changed without a matching manifest change: ${path.posix.basename(lockfile)}`,
        changedLine(change),
        paired
          ? "Review the lockfile updates and keep them aligned with the approved manifest change; revert unrelated package churn."
          : "Revert the lockfile change or update the matching manifest only when a dependency change is explicitly approved."
      ));
    }
  }

  return findings;
}

export function isLockfile(file: string): boolean {
  return lockfiles.has(path.posix.basename(file.replace(/\\/g, "/")));
}

function changePaths(change: FileChange): string[] {
  return [...new Set([change.oldFile, change.newFile, change.file].filter((value): value is string => Boolean(value)).map((value) => value.replace(/\\/g, "/")))];
}

function isManifest(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  const name = path.posix.basename(normalized);
  return name === "package.json" || name === "pyproject.toml" || name === "Pipfile" ||
    name === "go.mod" || name === "Cargo.toml" || /^requirements.*\.txt$/i.test(name) ||
    name === "pom.xml" || name === "build.gradle" || name === "build.gradle.kts" ||
    name.endsWith(".csproj") || name === "Gemfile";
}

function correspondingManifest(lockfile: string): string | undefined {
  const normalized = lockfile.replace(/\\/g, "/");
  const directory = path.posix.dirname(normalized);
  const name = path.posix.basename(normalized);
  const manifestName = name === "package-lock.json" || name === "npm-shrinkwrap.json" || name === "pnpm-lock.yaml" || name.startsWith("yarn.lock") || name.startsWith("bun.lock")
    ? "package.json"
    : name === "poetry.lock" || name === "Pipfile.lock"
      ? (name === "Pipfile.lock" ? "Pipfile" : "pyproject.toml")
      : name === "Cargo.lock"
        ? "Cargo.toml"
        : name === "go.sum"
          ? "go.mod"
          : name === "Gemfile.lock"
            ? "Gemfile"
            : name === "gradle.lockfile"
              ? "build.gradle.kts"
              : undefined;
  return manifestName ? path.posix.join(directory, manifestName) : undefined;
}

function extractDependencies(file: string, content: string): Map<string, string> {
  const name = path.posix.basename(file.replace(/\\/g, "/"));
  if (!content) return new Map();
  if (name === "package.json") return parsePackageJson(content);
  if (/^requirements.*\.txt$/i.test(name)) return parseRequirements(content);
  if (name === "go.mod") return parseGoMod(content);
  if (name === "Cargo.toml") return parseCargoToml(content);
  if (name === "Pipfile") return parsePipfile(content);
  if (name === "pyproject.toml") return parsePyproject(content);
  if (name === "pom.xml") return parsePomXml(content);
  if (name === "build.gradle" || name === "build.gradle.kts") return parseGradle(content);
  if (name.endsWith(".csproj")) return parseCsProj(content);
  if (name === "Gemfile") return parseGemfile(content);
  return new Map();
}

function parsePackageJson(content: string): Map<string, string> {
  const result = new Map<string, string>();
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return result;
    const root = parsed as Record<string, unknown>;
    for (const section of dependencySections) {
      const values = root[section];
      if (typeof values !== "object" || values === null || Array.isArray(values)) continue;
      for (const [packageName, version] of Object.entries(values)) {
        result.set(packageName, stringifyVersion(version));
      }
    }
    const scripts = root.scripts;
    if (typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)) {
      const lifecycle = ["preinstall", "install", "postinstall", "preuninstall", "postuninstall"];
      for (const [key, val] of Object.entries(scripts)) {
        if (lifecycle.includes(key.toLowerCase())) {
          result.set(`${key} script`, stringifyVersion(val));
        }
      }
    }
  } catch {
    return result;
  }
  return result;
}

function parseRequirements(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const eggName = /#egg=([A-Za-z0-9_.-]+)/.exec(line)?.[1];
    if (eggName) {
      result.set(eggName, line);
      continue;
    }
    if (line.startsWith("-") || line.startsWith("http://") || line.startsWith("https://")) continue;
    const match = /^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(.*)$/.exec(line);
    if (match) result.set(match[1], match[2].replace(/^@\s*/, "").trim());
  }
  return result;
}

function parseGoMod(content: string): Map<string, string> {
  const result = new Map<string, string>();
  let inRequireBlock = false;
  let inReplaceBlock = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (/^require\s*\($/.test(line)) {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ")") {
      inRequireBlock = false;
      continue;
    }
    if (/^replace\s*\($/.test(line)) {
      inReplaceBlock = true;
      continue;
    }
    if (inReplaceBlock && line === ")") {
      inReplaceBlock = false;
      continue;
    }
    const match = inRequireBlock
      ? /^([^\s]+)\s+([^\s]+)$/.exec(line)
      : /^require\s+([^\s]+)\s+([^\s]+)$/.exec(line);
    if (match) {
      result.set(match[1], match[2]);
      continue;
    }
    const repMatch = inReplaceBlock
      ? /^([^\s]+)(?:\s+[^\s]+)?\s*=>\s*(.+)$/.exec(line)
      : /^replace\s+([^\s]+)(?:\s+[^\s]+)?\s*=>\s*(.+)$/.exec(line);
    if (repMatch) {
      result.set(`replace directive: ${repMatch[1]}`, repMatch[2]);
    }
  }
  return result;
}

function parsePomXml(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const depRegex = /<dependency>([\s\S]*?)<\/dependency>/g;
  for (const match of content.matchAll(depRegex)) {
    const block = match[1];
    const group = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(block)?.[1] ?? "";
    const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(block)?.[1] ?? "";
    const version = /<version>\s*([^<\s]+)\s*<\/version>/.exec(block)?.[1] ?? "*";
    if (group || artifact) {
      result.set(`${group}:${artifact}`, version);
    }
  }
  return result;
}

function parseGradle(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const depRegex = /\b(?:implementation|api|testImplementation|compileOnly|runtimeOnly)\s*(?:\(|\s)\s*["']([^"':]+):([^"':]+)(?::([^"':]+))?["']/g;
  for (const match of content.matchAll(depRegex)) {
    const group = match[1];
    const artifact = match[2];
    const version = match[3] ?? "*";
    result.set(`${group}:${artifact}`, version);
  }
  return result;
}

function parseCsProj(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const pkgRegex = /<PackageReference\s+[^>]*Include=["']([^"']+)["'][^>]*(?:Version=["']([^"']+)["'])?/gi;
  for (const match of content.matchAll(pkgRegex)) {
    const name = match[1];
    const version = match[2] ?? "*";
    result.set(name, version);
  }
  return result;
}

function parseGemfile(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const match = /^gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/.exec(line);
    if (match) {
      result.set(match[1], match[2] ?? "*");
    }
  }
  return result;
}

function parseCargoToml(content: string): Map<string, string> {
  const result = new Map<string, string>();
  let inDependencies = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(rawLine);
    if (section) {
      inDependencies = /(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies)$/.test(section[1]);
      continue;
    }
    if (!inDependencies) continue;
    const entry = /^\s*(["']?[^"'=\s]+["']?)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(rawLine);
    if (!entry) continue;
    const packageName = entry[1].replace(/["']/g, "");
    const packageValue = entry[2];
    const packageNameField = /\bpackage\s*=\s*["']([^"']+)["']/.exec(packageValue)?.[1];
    const version = /\bversion\s*=\s*["']([^"']+)["']/.exec(packageValue)?.[1] ?? unquote(packageValue);
    result.set(packageNameField ?? packageName, version);
  }
  return result;
}

function parsePipfile(content: string): Map<string, string> {
  const result = new Map<string, string>();
  let inPackages = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(rawLine);
    if (section) {
      inPackages = section[1] === "packages" || section[1] === "dev-packages";
      continue;
    }
    if (!inPackages) continue;
    const entry = /^\s*(["']?[^"'=\s]+["']?)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(rawLine);
    if (entry) result.set(entry[1].replace(/["']/g, ""), unquote(entry[2]));
  }
  return result;
}

function parsePyproject(content: string): Map<string, string> {
  const result = new Map<string, string>();
  let section = "";
  let readingDependencyArray = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(rawLine);
    if (header) {
      section = header[1];
      readingDependencyArray = false;
      continue;
    }
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    const isPoetryDependencySection = section === "tool.poetry.dependencies" ||
      section === "tool.poetry.dev-dependencies" ||
      /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section);
    const isProjectDependencySection = section === "project" || section === "project.optional-dependencies" || section.startsWith("project.optional-dependencies.");
    const isBuildRequirementSection = section === "build-system";
    if (isPoetryDependencySection) {
      const entry = /^(["']?[^"'=\s]+["']?)\s*=\s*(.+)$/.exec(line);
      if (entry && entry[1].replace(/["']/g, "").toLowerCase() !== "python") {
        result.set(entry[1].replace(/["']/g, ""), unquote(entry[2]));
      }
      continue;
    }
    if (isProjectDependencySection && (/^dependencies\s*=/.test(line) || /^optional-dependencies\s*=/.test(line))) {
      readingDependencyArray = true;
    } else if (section === "project.optional-dependencies" && /^[^=]+\s*=/.test(line)) {
      readingDependencyArray = true;
    } else if (isBuildRequirementSection && /^requires\s*=/.test(line)) {
      readingDependencyArray = true;
    }
    if (readingDependencyArray) {
      for (const match of line.matchAll(/["']([^"']+)["']/g)) {
        const dependency = /^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(.*)$/.exec(match[1]);
        if (dependency) result.set(dependency[1], dependency[2].trim());
      }
      if (line.includes("]")) readingDependencyArray = false;
    }
  }
  return result;
}

function stringifyVersion(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}
