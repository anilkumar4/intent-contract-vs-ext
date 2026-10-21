import path from "node:path";
import type * as ts from "typescript";
import picomatch from "picomatch";
import { makeFinding } from "./finding";
import type { Contract, Finding, ParsedDiff } from "./types";
import { gitBuffer } from "../git/cli";
import { parseArchitectureDiagram, type DiagramGraph } from "./architecture/diagram";
import { toRepoPath } from "../util/paths";

const MAX_DIAGRAM_BYTES = 5 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

interface ImportReference {
  specifier: string;
  line: number;
}

interface ResolvedImport {
  key: string;
  line: number;
  sourceNode?: string;
  targetNode?: string;
  targetPath?: string;
  internal: boolean;
  issue?: string;
}

interface NodeMapping {
  nodeId: string;
  patterns: string[];
}

export async function detectArchitectureDrift(
  root: string,
  policyTree: string,
  diff: ParsedDiff,
  contract: Contract,
  contractFile = ".intent/contract.yaml"
): Promise<Finding[]> {
  const architecture = contract.architecture;
  if (!architecture || !contract.forbid.includes("architecture_drift")) return [];

  const findings: Finding[] = [];
  const diagramPath = resolveDiagramPath(architecture.diagram);
  if (!diagramPath) {
    return [policyWarning(architecture.diagram, "diagram_path", "Architecture diagram path must stay inside the repository: " + architecture.diagram)];
  }

  let diagramSource: string;
  try {
    const buffer = await gitBuffer(root, ["cat-file", "blob", policyTree + ":" + diagramPath]);
    if (buffer.byteLength > MAX_DIAGRAM_BYTES) throw new Error("diagram exceeds 5 MiB");
    diagramSource = buffer.toString("utf8");
  } catch (error) {
    return [policyWarning(diagramPath, "diagram_unavailable", "Could not read architecture diagram from the policy baseline: " + errorMessage(error))];
  }

  const graph = parseArchitectureDiagram(architecture.diagram, diagramSource);
  for (const warning of graph.warnings) findings.push(policyWarning(diagramPath, "diagram_parse", warning));
  if (graph.nodes.length === 0) {
    if (findings.length === 0) findings.push(policyWarning(diagramPath, "diagram_empty", "Architecture diagram contains no recognized nodes."));
    return findings;
  }

  const mappingResult = buildMappings(graph, architecture.node_mappings);
  findings.push(...mappingResult.warnings.map((warning) => policyWarning(contractFile, "node_mapping", warning)));
  const allowedEdges = new Set(graph.edges.map(({ from, to }) => from + "\0" + to));
  const typescript = await import("typescript");
  const compilerOptions = await loadCompilerOptions(root, typescript);

  for (const change of diff.changes) {
    const beforePath = change.oldFile ?? change.file;
    const afterPath = change.newFile ?? change.file;
    const beforeSupported = change.beforeContent !== undefined && SOURCE_EXTENSIONS.has(path.extname(beforePath).toLowerCase());
    const afterSupported = change.afterContent !== undefined && SOURCE_EXTENSIONS.has(path.extname(afterPath).toLowerCase());
    if (!afterSupported || change.afterContent === undefined) continue;

    const current = await inspectContent(root, afterPath, change.afterContent, mappingResult.mappings, compilerOptions, typescript);
    const previous = beforeSupported && change.beforeContent !== undefined
      ? await inspectContent(root, beforePath, change.beforeContent, mappingResult.mappings, compilerOptions, typescript)
      : [];
    const previousKeys = new Set(previous.map((item) => item.key));
    for (const item of current) {
      if (previousKeys.has(item.key)) continue;
      if (item.issue) {
        findings.push(policyWarning(afterPath, "import_resolution", item.issue, item.line));
        continue;
      }
      if (!item.internal || !item.sourceNode || !item.targetNode) continue;
      if (!allowedEdges.has(item.sourceNode + "\0" + item.targetNode)) {
        const targetName = graph.nodes.find((node) => node.id === item.targetNode)?.label ?? item.targetNode;
        const sourceName = graph.nodes.find((node) => node.id === item.sourceNode)?.label ?? item.sourceNode;
        const evidence = "+ " + sourceName + " imports " + (item.targetPath ?? item.key) + " (" + targetName + ")";
        findings.push(makeFinding(
          "architecture_drift",
          afterPath,
          "unlisted_edge",
          evidence,
          "error",
          "Architecture boundary " + sourceName + " → " + targetName + " is not allowed by " + architecture.diagram + ".",
          item.line,
          "Add an explicit " + sourceName + " → " + targetName + " arrow to the baseline diagram, or remove the new import."
        ));
      }
    }
  }
  return findings;
}

async function inspectContent(
  root: string,
  repoPath: string,
  content: string,
  mappings: NodeMapping[],
  compilerOptions: ts.CompilerOptions,
  typescript: typeof import("typescript")
): Promise<ResolvedImport[]> {
  const extension = path.extname(repoPath).toLowerCase();
  const absolutePath = path.resolve(root, repoPath);
  const scriptKind = extension === ".tsx" || extension === ".jsx"
    ? typescript.ScriptKind.TSX
    : [".js", ".mjs", ".cjs", ".jsx"].includes(extension) ? typescript.ScriptKind.JS : typescript.ScriptKind.TS;
  const sourceFile = typescript.createSourceFile(absolutePath, content, typescript.ScriptTarget.Latest, true, scriptKind);
  const references = collectImports(sourceFile, typescript);
  const source = matchNode(repoPath, mappings);
  const resolved: ResolvedImport[] = [];

  for (const reference of references) {
    const result = typescript.resolveModuleName(reference.specifier, absolutePath, compilerOptions, typescript.sys).resolvedModule;
    if (!result) {
      const likelyInternal = reference.specifier.startsWith(".") || reference.specifier.startsWith("/") || reference.specifier.startsWith("#");
      resolved.push({
        key: (source.nodeId ?? "?") + "\0" + reference.specifier,
        line: reference.line,
        internal: likelyInternal,
        sourceNode: source.nodeId,
        issue: likelyInternal
          ? "Could not resolve internal import “" + reference.specifier + "” from " + repoPath + "."
          : undefined
      });
      continue;
    }

    const targetAbsolute = path.resolve(result.resolvedFileName);
    const targetRelative = path.relative(root, targetAbsolute);
    const isInsideRepo = targetRelative !== ".." &&
      !targetRelative.startsWith(".." + path.sep) &&
      !path.isAbsolute(targetRelative) &&
      !targetRelative.split(path.sep).includes("node_modules");
    if (!isInsideRepo) {
      resolved.push({ key: (source.nodeId ?? "?") + "\0" + reference.specifier, line: reference.line, internal: false });
      continue;
    }

    const targetPath = toRepoPath(targetRelative);
    const target = matchNode(targetPath, mappings);
    resolved.push({
      key: (source.nodeId ?? "?") + "\0" + (target.nodeId ?? "?"),
      line: reference.line,
      sourceNode: source.nodeId,
      targetNode: target.nodeId,
      targetPath,
      internal: true,
      issue: source.issue ?? target.issue
    });
  }
  if (references.length > 0 && source.issue) {
    resolved.push({ key: "mapping-warning:" + repoPath, line: references[0].line, internal: false, issue: source.issue });
  }
  return resolved;
}

function collectImports(sourceFile: ts.SourceFile, typescript: typeof import("typescript")): ImportReference[] {
  const references: ImportReference[] = [];
  const add = (node: ts.Node, expression: ts.Expression | undefined): void => {
    if (expression && typescript.isStringLiteralLike(expression)) {
      references.push({
        specifier: expression.text,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      });
    }
  };
  const visit = (node: ts.Node): void => {
    if (typescript.isImportDeclaration(node) || typescript.isExportDeclaration(node)) {
      add(node, node.moduleSpecifier && typescript.isExpression(node.moduleSpecifier) ? node.moduleSpecifier : undefined);
    } else if (typescript.isImportEqualsDeclaration(node) && typescript.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression);
    } else if (typescript.isCallExpression(node) && node.arguments.length === 1 &&
      (node.expression.kind === typescript.SyntaxKind.ImportKeyword || (typescript.isIdentifier(node.expression) && node.expression.text === "require"))) {
      add(node, node.arguments[0]);
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function buildMappings(graph: DiagramGraph, rawMappings: Record<string, string[]>): { mappings: NodeMapping[]; warnings: string[] } {
  const aliases = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    for (const alias of [node.id, node.label]) {
      const matches = aliases.get(alias) ?? new Set<string>();
      matches.add(node.id);
      aliases.set(alias, matches);
    }
  }
  const byNode = new Map<string, string[]>();
  const warnings: string[] = [];
  for (const [alias, patterns] of Object.entries(rawMappings)) {
    const matchingNodes = aliases.get(alias);
    if (!matchingNodes?.size) {
      warnings.push("Node mapping “" + alias + "” does not match any diagram node ID or label.");
      continue;
    }
    if (matchingNodes.size > 1) {
      warnings.push("Node mapping “" + alias + "” matches more than one diagram node.");
      continue;
    }
    const nodeId = [...matchingNodes][0];
    byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), ...patterns]);
  }
  return { mappings: [...byNode.entries()].map(([nodeId, patterns]) => ({ nodeId, patterns })), warnings };
}

function matchNode(repoPath: string, mappings: NodeMapping[]): { nodeId?: string; issue?: string } {
  const matches = mappings.filter((mapping) => mapping.patterns.some((pattern) => picomatch.isMatch(repoPath, pattern, { dot: true })));
  if (matches.length === 0) return { issue: "Repository path “" + repoPath + "” does not match an architecture node mapping." };
  if (matches.length > 1) return { issue: "Repository path “" + repoPath + "” matches multiple architecture node mappings." };
  return { nodeId: matches[0].nodeId };
}

async function loadCompilerOptions(root: string, typescript: typeof import("typescript")): Promise<ts.CompilerOptions> {
  const configPath = typescript.findConfigFile(root, typescript.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    return { moduleResolution: typescript.ModuleResolutionKind.NodeNext, module: typescript.ModuleKind.NodeNext, allowJs: true, resolveJsonModule: true };
  }
  const config = typescript.readConfigFile(configPath, typescript.sys.readFile);
  if (config.error) {
    return { moduleResolution: typescript.ModuleResolutionKind.NodeNext, module: typescript.ModuleKind.NodeNext, allowJs: true, resolveJsonModule: true };
  }
  return typescript.parseJsonConfigFileContent(config.config, typescript.sys, path.dirname(configPath)).options;
}

function resolveDiagramPath(reference: string): string | undefined {
  const plainPath = reference.split("#", 1)[0].replace(/\\/g, "/");
  if (path.posix.isAbsolute(plainPath) || plainPath.split("/").some((segment) => segment === "..")) return undefined;
  return toRepoPath(plainPath.replace(/^\.\//, ""));
}

function policyWarning(file: string, rule: string, message: string, line?: number): Finding {
  return makeFinding("architecture_drift", file, rule, message, "warning", message, line, "Correct the diagram, import, or node mapping so the architecture policy can be evaluated.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
