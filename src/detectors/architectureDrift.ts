import fs from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import type * as ts from "typescript";
import { parseArchitectureDiagram } from "../architecture/diagramParser";
import type { ArchitectureGraph, DirectedArchitectureEdge } from "../architecture/diagramParser";
import { gitBuffer } from "../git/cli";
import { toRepoPath } from "../util/paths";
import { makeFinding } from "./finding";
import type { Contract, Finding, ParsedDiff } from "./types";

const MAX_DIAGRAM_BYTES = 5 * 1024 * 1024;
const JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const SOURCE_EXTENSIONS = new Set([...JS_EXTENSIONS, ".py", ".go"]);

interface ImportRef { specifier: string; line: number; fallbackSpecifier?: string }
interface Mapping { nodeId: string; patterns: string[] }
export interface ArchitectureViolation {
  sourceNode: string; targetNode: string; sourceFile: string; targetFile: string; line: number;
}
export interface ArchitectureAnalysis {
  graph: ArchitectureGraph; findings: Finding[]; violations: ArchitectureViolation[];
}

export async function detectArchitectureDrift(
  root: string, policyTree: string, diff: ParsedDiff, contract: Contract, contractFile = ".intent/contract.yaml"
): Promise<Finding[]> {
  return (await analyzeArchitectureDrift(root, policyTree, diff, contract, contractFile)).findings;
}

export async function analyzeArchitectureDrift(
  root: string, policyTree: string, diff: ParsedDiff, contract: Contract, contractFile = ".intent/contract.yaml"
): Promise<ArchitectureAnalysis> {
  const empty = (): ArchitectureAnalysis => ({ graph: { nodes: new Map(), allowedEdges: new Set() }, findings: [], violations: [] });
  const result = empty();
  const architecture = contract.architecture;
  if (!architecture || !contract.forbid.includes("architecture_drift")) return result;

  const diagramPath = safeDiagramPath(architecture.diagram);
  if (!diagramPath) {
    result.findings.push(warning(architecture.diagram, "diagram_path", "Architecture diagram path must stay inside the repository."));
    return result;
  }
  try {
    const blob = await gitBuffer(root, ["cat-file", "blob", policyTree + ":" + diagramPath]);
    if (blob.byteLength > MAX_DIAGRAM_BYTES) throw new Error("diagram exceeds 5 MiB");
    result.graph = parseArchitectureDiagram(architecture.diagram, blob.toString("utf8"));
  } catch (error) {
    result.findings.push(warning(diagramPath, "diagram_unavailable", "Could not read or parse architecture diagram from the policy baseline: " + errorText(error)));
    return result;
  }
  if (!result.graph.nodes.size) {
    result.findings.push(warning(diagramPath, "diagram_empty", "Architecture diagram contains no recognized nodes."));
    return result;
  }

  const mappingResult = buildMappings(result.graph, architecture.node_mappings);
  result.findings.push(...mappingResult.warnings.map((message) => warning(contractFile, "node_mapping", message)));
  const warningMessages = new Set(result.findings.map((finding) => finding.message));
  const typescript = await import("typescript");
  const compilerOptions = await loadCompilerOptions(root, typescript);
  const goModule = await loadGoModule(root);

  for (const change of diff.changes) {
    if (change.status !== "M" && change.status !== "A" && change.status !== "R") continue;
    const sourcePath = change.newFile ?? change.file;
    const extension = path.extname(sourcePath).toLowerCase();
    if (change.afterContent === undefined || !SOURCE_EXTENSIONS.has(extension)) continue;
    const imports = JS_EXTENSIONS.has(extension)
      ? collectJsImports(sourcePath, change.afterContent, typescript)
      : extension === ".py" ? collectPythonImports(change.afterContent) : collectGoImports(change.afterContent);
    if (!imports.length) continue;
    const sourceNode = matchNode(sourcePath, mappingResult.mappings);

    for (const imported of imports) {
      const resolved = JS_EXTENSIONS.has(extension)
        ? await resolveJs(root, sourcePath, imported.specifier, compilerOptions, typescript)
        : extension === ".py"
          ? await resolvePython(root, sourcePath, imported.specifier, imported.fallbackSpecifier)
          : await resolveGo(root, sourcePath, imported.specifier, goModule);
      if (resolved.issue) {
        if (!warningMessages.has(resolved.issue)) {
          warningMessages.add(resolved.issue);
          result.findings.push(warning(sourcePath, "import_resolution", resolved.issue, imported.line));
        }
        continue;
      }
      if (!resolved.internal || !resolved.targetPath) continue;
      const targetNode = matchNode(resolved.targetPath, mappingResult.mappings);
      const mappingIssue = sourceNode.issue ?? targetNode.issue;
      if (mappingIssue) {
        if (!warningMessages.has(mappingIssue)) {
          warningMessages.add(mappingIssue);
          result.findings.push(warning(sourcePath, "node_mapping", mappingIssue, imported.line));
        }
        continue;
      }
      if (!sourceNode.nodeId || !targetNode.nodeId || sourceNode.nodeId === targetNode.nodeId) continue;
      const sourceId = sourceNode.nodeId;
      const targetId = targetNode.nodeId;
      const edge = (sourceId + "->" + targetId) as DirectedArchitectureEdge;
      if (result.graph.allowedEdges.has(edge)) continue;

      const sourceLabel = result.graph.nodes.get(sourceId)?.label ?? sourceId;
      const targetLabel = result.graph.nodes.get(targetId)?.label ?? targetId;
      const outgoing = [...result.graph.allowedEdges]
        .filter((value) => value.startsWith(sourceId + "->"))
        .map((value) => result.graph.nodes.get(value.slice(sourceId.length + 2))?.label ?? value.slice(sourceId.length + 2));
      const allowed = [...new Set(outgoing)].sort().join(", ") || "none";
      const tick = "\x60";
      const message = "Architectural Drift: Module " + tick + sourceLabel + tick + " (" + tick + sourcePath + tick +
        ") imports from " + tick + targetLabel + tick + " (" + tick + resolved.targetPath + tick +
        "), which violates " + tick + architecture.diagram + tick + " (allowed outgoing dependencies from " +
        tick + sourceLabel + tick + ": " + tick + allowed + tick + ").";
      const detail: ArchitectureViolation = {
        sourceNode: sourceId, targetNode: targetId,
        sourceFile: sourcePath, targetFile: resolved.targetPath, line: imported.line
      };
      result.findings.push(makeFinding(
        "architecture_drift", sourcePath, "unlisted_edge", JSON.stringify(detail), "error", message, imported.line,
        "Add an explicit " + sourceLabel + " → " + targetLabel + " arrow to the baseline diagram, or remove the import."
      ));
      result.violations.push(detail);
    }
  }
  return result;
}

export function renderArchitectureDriftDiagram(graph: ArchitectureGraph, violations: ArchitectureViolation[], diagramPath: string): string {
  const nodes = [...graph.nodes.values()];
  const ids = new Map(nodes.map((node, index) => [node.id, "N" + index]));
  const lines = ["%% Architecture drift report", "%% Official policy diagram: " + diagramPath, "flowchart LR"];
  for (const node of nodes) {
    const id = ids.get(node.id) ?? "N_" + node.id.replace(/[^A-Za-z0-9_]/g, "_");
    const label = node.globs.length ? node.label + "<br/>" + node.globs.join(", ") : node.label;
    lines.push("  " + id + "[\"" + escapeLabel(label) + "\"]");
  }
  let linkIndex = 0;
  for (const edge of graph.allowedEdges) {
    const index = edge.indexOf("->");
    const from = ids.get(edge.slice(0, index));
    const to = ids.get(edge.slice(index + 2));
    if (!from || !to) continue;
    lines.push("  " + from + " --> " + to);
    lines.push("  linkStyle " + linkIndex++ + " stroke:#4caf50,stroke-width:2px,color:#ffffff");
  }
  for (const violation of violations) {
    const from = ids.get(violation.sourceNode);
    const to = ids.get(violation.targetNode);
    if (!from || !to) continue;
    const label = "VIOLATION: " + violation.sourceFile + ":" + violation.line + " imports " + violation.targetFile;
    lines.push("  " + from + " -.-x |" + escapeLabel(label) + "| " + to);
    lines.push("  linkStyle " + linkIndex++ + " stroke:#e53935,stroke-width:3px,color:#e53935,stroke-dasharray:5 5");
  }
  return lines.join("\n") + "\n";
}

function collectJsImports(file: string, content: string, tsApi: typeof import("typescript")): ImportRef[] {
  const extension = path.extname(file).toLowerCase();
  const kind = extension === ".tsx" || extension === ".jsx" ? tsApi.ScriptKind.TSX
    : [".js", ".mjs", ".cjs"].includes(extension) ? tsApi.ScriptKind.JS : tsApi.ScriptKind.TS;
  const source = tsApi.createSourceFile(file, content, tsApi.ScriptTarget.Latest, true, kind);
  const imports: ImportRef[] = [];
  const add = (node: ts.Node, expression: ts.Expression | undefined): void => {
    if (expression && tsApi.isStringLiteralLike(expression)) {
      imports.push({ specifier: expression.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    }
  };
  const visit = (node: ts.Node): void => {
    if (tsApi.isImportDeclaration(node) || tsApi.isExportDeclaration(node)) {
      add(node, node.moduleSpecifier && tsApi.isExpression(node.moduleSpecifier) ? node.moduleSpecifier : undefined);
    } else if (tsApi.isImportEqualsDeclaration(node) && tsApi.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression);
    } else if (tsApi.isCallExpression(node) && node.arguments.length === 1 &&
      (node.expression.kind === tsApi.SyntaxKind.ImportKeyword ||
        (tsApi.isIdentifier(node.expression) && node.expression.text === "require"))) {
      add(node, node.arguments[0]);
    }
    tsApi.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function collectPythonImports(content: string): ImportRef[] {
  const imports: ImportRef[] = [];
  let statement = "";
  let statementLine = 1;
  let parenthesisDepth = 0;
  const flush = (): void => {
    for (const line of statement.split(";")) {
      const from = /^from\s+([.\w]+)\s+import\s+(.+)$/.exec(line.trim());
      if (from) {
        const importedNames = from[2].replace(/[()]/g, "").split(",");
        for (const entry of importedNames) {
          const name = entry.trim().split(/\s+as\s+/i)[0];
          if (!name) continue;
          if (name === "*") {
            imports.push({ specifier: from[1], line: statementLine });
            continue;
          }
          const specifier = from[1].endsWith(".") ? from[1] + name : from[1] + "." + name;
          imports.push({ specifier, fallbackSpecifier: from[1], line: statementLine });
        }
        continue;
      }
      const match = /^import\s+(.+)$/.exec(line.trim());
      if (match) for (const entry of match[1].split(",")) {
        const module = entry.trim().split(/\s+as\s+/i)[0];
        if (module) imports.push({ specifier: module, line: statementLine });
      }
    }
    statement = "";
    parenthesisDepth = 0;
  };

  for (const [index, raw] of content.split(/\r?\n/).entries()) {
    let line = raw.split("#", 1)[0].trim();
    if (!line && !statement) continue;
    if (!statement) statementLine = index + 1;
    const explicitContinuation = /\\\s*$/.test(line);
    if (explicitContinuation) line = line.replace(/\\\s*$/, "");
    statement += (statement ? " " : "") + line;
    for (const character of line) {
      if (character === "(") parenthesisDepth += 1;
      else if (character === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    }
    if (!explicitContinuation && parenthesisDepth === 0) flush();
  }
  if (statement) flush();
  return imports;
}

async function resolvePython(root: string, sourcePath: string, specifier: string, fallbackSpecifier?: string):
Promise<{ targetPath?: string; internal: boolean; issue?: string }> {
  const relative = specifier.startsWith(".");
  let base: string;
  if (relative) {
    const level = specifier.match(/^\.+/)?.[0].length ?? 1;
    base = path.dirname(path.resolve(root, sourcePath));
    for (let index = 1; index < level; index += 1) base = path.dirname(base);
    base = path.resolve(base, specifier.slice(level).replace(/\./g, path.sep));
  } else {
    base = path.resolve(root, specifier.replace(/\./g, path.sep));
  }
  for (const candidate of [base + ".py", path.join(base, "__init__.py")]) {
    if (await isFile(candidate)) return { targetPath: toRepoPath(path.relative(root, candidate)), internal: true };
  }
  if (await isDirectory(base)) {
    const file = (await fs.readdir(base).catch(() => [])).filter((name) => name.endsWith(".py")).sort()[0];
    if (file) return { targetPath: toRepoPath(path.relative(root, path.join(base, file))), internal: true };
  }
  if (fallbackSpecifier && fallbackSpecifier !== specifier) {
    const fallback = await resolvePython(root, sourcePath, fallbackSpecifier);
    if (fallback.internal || fallback.issue) return fallback;
  }
  if (relative) return { internal: true, issue: "Could not resolve internal Python import " + specifier + " from " + sourcePath + "." };
  return { internal: false };
}

function collectGoImports(content: string): ImportRef[] {
  const imports: ImportRef[] = [];
  const expression = /\bimport\s+(?:\(([\s\S]*?)\)|"([^"]+)"|\x60([^\x60]+)\x60)/g;
  for (const match of content.matchAll(expression)) {
    if (match[2] || match[3]) {
      imports.push({ specifier: match[2] ?? match[3], line: lineAt(content, match.index ?? 0) });
      continue;
    }
    const body = match[1] ?? "";
    const offset = (match.index ?? 0) + match[0].indexOf(body);
    for (const item of body.matchAll(/^\s*(?:[\w.]+\s+)?(?:"([^"]+)"|\x60([^\x60]+)\x60)/gm)) {
      imports.push({ specifier: item[1] ?? item[2], line: lineAt(content, offset + (item.index ?? 0)) });
    }
  }
  return imports;
}

async function resolveJs(root: string, sourcePath: string, specifier: string, options: ts.CompilerOptions, tsApi: typeof import("typescript")):
Promise<{ targetPath?: string; internal: boolean; issue?: string }> {
  const resolved = tsApi.resolveModuleName(specifier, path.resolve(root, sourcePath), options, tsApi.sys).resolvedModule;
  if (resolved) {
    const relative = path.relative(root, path.resolve(resolved.resolvedFileName));
    if (!isRepoPath(relative) || relative.split(path.sep).includes("node_modules")) return { internal: false };
    return { targetPath: toRepoPath(relative), internal: true };
  }
  const alias = Object.keys(options.paths ?? {}).some((pattern) => {
    const index = pattern.indexOf("*");
    const prefix = index < 0 ? pattern : pattern.slice(0, index);
    const suffix = index < 0 ? "" : pattern.slice(index + 1);
    return specifier.startsWith(prefix) && specifier.endsWith(suffix);
  });
  const internal = specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#") || alias;
  return internal
    ? { internal: true, issue: "Could not resolve internal import " + specifier + " from " + sourcePath + "." }
    : { internal: false };
}


async function resolveGo(root: string, sourcePath: string, specifier: string, module: string | undefined):
Promise<{ targetPath?: string; internal: boolean; issue?: string }> {
  let relative: string;
  if (module && (specifier === module || specifier.startsWith(module + "/"))) {
    relative = specifier.slice(module.length).replace(/^\/+/, "");
  } else if (specifier.startsWith(".")) {
    relative = path.relative(root, path.resolve(root, path.dirname(sourcePath), specifier));
  } else return { internal: false };
  const directory = path.resolve(root, relative);
  const files = await fs.readdir(directory).catch(() => undefined);
  if (!files) return { internal: true, issue: "Could not resolve internal Go import " + specifier + " from " + sourcePath + "." };
  const file = files.filter((name) => name.endsWith(".go") && !name.endsWith("_test.go")).sort()[0];
  if (!file) return { internal: true, issue: "Go import " + specifier + " has no source file in " + toRepoPath(relative) + "." };
  return { targetPath: toRepoPath(path.relative(root, path.join(directory, file))), internal: true };
}

function buildMappings(graph: ArchitectureGraph, configured: Record<string, string[]>): { mappings: Mapping[]; warnings: string[] } {
  const aliases = new Map<string, Set<string>>();
  const patterns = new Map<string, string[]>();
  const warnings: string[] = [];
  for (const node of graph.nodes.values()) {
    for (const name of [node.id, node.label]) {
      const ids = aliases.get(name) ?? new Set<string>();
      ids.add(node.id);
      aliases.set(name, ids);
    }
    if (node.globs.length) patterns.set(node.id, [...node.globs]);
  }
  for (const [alias, globs] of Object.entries(configured)) {
    const ids = aliases.get(alias);
    if (!ids?.size) { warnings.push("Node mapping " + alias + " does not match a diagram node ID or label."); continue; }
    if (ids.size > 1) { warnings.push("Node mapping " + alias + " matches multiple diagram nodes."); continue; }
    const id = [...ids][0];
    patterns.set(id, [...(patterns.get(id) ?? []), ...globs]);
  }
  return { mappings: [...patterns].map(([nodeId, values]) => ({ nodeId, patterns: [...new Set(values)] })), warnings };
}

function matchNode(file: string, mappings: Mapping[]): { nodeId?: string; issue?: string } {
  const repoPath = toRepoPath(file);
  const matches = mappings.filter((mapping) => mapping.patterns.some((glob) => picomatch.isMatch(repoPath, glob, { dot: true })));
  if (!matches.length) return { issue: "Repository path " + repoPath + " does not match an architecture node mapping." };
  if (matches.length > 1) return { issue: "Repository path " + repoPath + " matches multiple architecture node mappings." };
  return { nodeId: matches[0].nodeId };
}

async function loadCompilerOptions(root: string, api: typeof import("typescript")): Promise<ts.CompilerOptions> {
  const file = api.findConfigFile(root, api.sys.fileExists, "tsconfig.json");
  if (!file) return { moduleResolution: api.ModuleResolutionKind.NodeNext, module: api.ModuleKind.NodeNext, allowJs: true, resolveJsonModule: true };
  const read = api.readConfigFile(file, api.sys.readFile);
  if (read.error) return { moduleResolution: api.ModuleResolutionKind.NodeNext, module: api.ModuleKind.NodeNext, allowJs: true, resolveJsonModule: true };
  return api.parseJsonConfigFileContent(read.config, api.sys, path.dirname(file)).options;
}

async function loadGoModule(root: string): Promise<string | undefined> {
  const goMod = await fs.readFile(path.join(root, "go.mod"), "utf8").catch(() => "");
  return /^\s*module\s+([^\s]+)\s*$/m.exec(goMod)?.[1];
}

function safeDiagramPath(reference: string): string | undefined {
  const file = reference.split("#", 1)[0].replace(/\\/g, "/");
  if (path.posix.isAbsolute(file) || file.split("/").some((part) => part === "..")) return undefined;
  return toRepoPath(file.replace(/^\.\//, ""));
}

function warning(file: string, rule: string, message: string, line?: number): Finding {
  return makeFinding("architecture_drift", file, rule, message, "warning", message, line, "Correct the diagram, import, or node mapping so policy can be evaluated.");
}

function escapeLabel(value: string): string {
  return value.replace(/[\r\n|"]/g, " ").replace(/\s+/g, " ").trim();
}
function isRepoPath(value: string): boolean {
  return value !== ".." && !value.startsWith(".." + path.sep) && !path.isAbsolute(value);
}
async function isFile(value: string): Promise<boolean> {
  return fs.stat(value).then((info) => info.isFile(), () => false);
}
async function isDirectory(value: string): Promise<boolean> {
  return fs.stat(value).then((info) => info.isDirectory(), () => false);
}
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source[index] === "\n") line += 1;
  return line;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
