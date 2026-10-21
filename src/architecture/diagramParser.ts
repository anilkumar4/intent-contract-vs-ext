import { inflateRawSync } from "node:zlib";

const MAX_EXPANDED_DIAGRAM_BYTES = 5 * 1024 * 1024;

export interface ArchitectureNode {
  id: string;
  label: string;
  globs: string[];
}

export type DirectedArchitectureEdge = `${string}->${string}`;

export interface ArchitectureGraph {
  nodes: Map<string, ArchitectureNode>;
  allowedEdges: Set<DirectedArchitectureEdge>;
}

export class DiagramParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagramParseError";
  }
}

export function parseArchitectureDiagram(filePath: string, source: string): ArchitectureGraph {
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith(".drawio.svg")) return parseDrawioSvg(source);
  if (normalized.endsWith(".drawio") || normalized.endsWith(".dio")) return parseDrawio(source);
  if (normalized.endsWith(".mmd")) return parseMermaid(source);
  if (/\.md(?:#.*)?$/i.test(normalized)) return parseMarkdownMermaid(filePath, source);
  throw new DiagramParseError("Unsupported architecture diagram format: " + filePath);
}

export function parseMarkdownMermaid(reference: string, markdown: string): ArchitectureGraph {
  const anchor = reference.includes("#") ? reference.slice(reference.indexOf("#") + 1) : "";
  const blocks: string[] = [];
  let sectionLevel = 0;
  let inSection = !anchor;
  let foundAnchor = !anchor;
  let inFence = false;
  let mermaidFence = false;
  let fenceChar = "";
  let fenceLength = 0;
  let block: string[] = [];

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!inFence && heading) {
      const level = heading[1].length;
      if (inSection && sectionLevel > 0 && level <= sectionLevel) inSection = false;
      if (!inSection && anchor && markdownSlug(heading[2]) === anchor.toLowerCase()) {
        inSection = true;
        sectionLevel = level;
        foundAnchor = true;
      }
      continue;
    }

    if (!inFence) {
      const opening = /^\s*((?:~{3,}|\x60{3,}))\s*([\w-]+)?\s*$/.exec(line);
      if (!opening) continue;
      inFence = true;
      fenceChar = opening[1][0];
      fenceLength = opening[1].length;
      mermaidFence = (opening[2] ?? "").toLowerCase() === "mermaid";
      block = [];
      continue;
    }

    const closing = /^\s*((?:~+|\x60+))\s*$/.exec(line);
    if (closing && closing[1][0] === fenceChar && closing[1].length >= fenceLength) {
      if (mermaidFence && inSection) blocks.push(block.join("\n"));
      inFence = false;
      mermaidFence = false;
      continue;
    }
    if (mermaidFence) block.push(line);
  }

  if (inFence && mermaidFence && inSection) blocks.push(block.join("\n"));
  if (anchor && !foundAnchor) {
    throw new DiagramParseError("Markdown heading anchor #" + anchor + " was not found in " + reference.split("#")[0] + ".");
  }
  if (blocks.length === 0) throw new DiagramParseError("No Mermaid code block was found in " + reference + ".");
  return mergeGraphs(blocks.map(parseMermaid));
}

export function parseMermaid(source: string): ArchitectureGraph {
  const graph = emptyGraph();
  const lines = source.split(/\r?\n/);
  const hasFlowchart = lines.some((line) => /^\s*(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b/i.test(stripMermaidComment(line)));
  const hasC4 = /\bC4(?:Context|Container|Component|Dynamic|Deployment)\b/i.test(source);
  if (!hasFlowchart && !hasC4) {
    throw new DiagramParseError("Expected a Mermaid flowchart, graph, or C4 diagram.");
  }

  parseC4(source, graph);
  if (!hasFlowchart) return graph;

  const edgePattern = /<-->|<-.->|<==>|<--|<-\.-|<-.|<==|-->|-\.->|-.-x|==>|---|-\.--|--|==/g;
  for (const originalLine of lines) {
    const line = stripMermaidComment(originalLine).trim();
    if (!line || /^\s*(?:flowchart|graph)\s+/i.test(line)) continue;
    if (/^(?:subgraph|end|direction|classDef|class|style|linkStyle|click|accTitle|accDescr|%%|---)\b/i.test(line)) continue;
    const matches = [...line.matchAll(edgePattern)];
    if (matches.length === 0) {
      const node = parseFlowNode(line);
      if (node) addNode(graph, node);
      continue;
    }

    const segments: string[] = [];
    let start = 0;
    for (const match of matches) {
      const index = match.index ?? 0;
      segments.push(line.slice(start, index));
      start = index + match[0].length;
    }
    segments.push(line.slice(start));
    const nodes = segments.map(parseFlowNode);
    for (const node of nodes) if (node) addNode(graph, node);
    for (let index = 0; index < matches.length; index += 1) {
      const left = nodes[index];
      const right = nodes[index + 1];
      if (!left || !right) continue;
      const operator = matches[index][0];
      if (operator.startsWith("<")) addEdge(graph, right.id, left.id);
      else addEdge(graph, left.id, right.id);
      if (operator === "<-->" || operator === "<-.->" || operator === "<==>") addEdge(graph, left.id, right.id);
    }
  }
  return graph;
}

export function parseDrawio(source: string): ArchitectureGraph {
  if (/<\s*!DOCTYPE|<\s*!ENTITY/i.test(source)) {
    throw new DiagramParseError("Draw.io XML with DTD or entity declarations is not supported.");
  }
  let xml = source;
  if (hasCompressedDiagram(xml)) {
    try {
      xml = expandCompressedDiagrams(xml);
    } catch (error) {
      throw new DiagramParseError("Could not decompress Draw.io diagram: " + errorMessage(error));
    }
  }
  const embedded = extractDrawioCompressedPayload(xml);
  if (embedded) {
    try {
      xml = inflateDrawioPayload(embedded);
    } catch (error) {
      throw new DiagramParseError("Could not decompress Draw.io diagram: " + errorMessage(error));
    }
  }
  if (!/<(?:mxfile|mxGraphModel)\b/i.test(xml)) {
    throw new DiagramParseError("Draw.io XML does not contain an mxfile or mxGraphModel root.");
  }

  const graph = emptyGraph();
  const stack: Array<{ name: string; value?: string; id?: string }> = [];
  const tags = xml.match(/<!--[\s\S]*?-->|<\?[^>]*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>/g) ?? [];
  for (const tag of tags) {
    if (tag.startsWith("<!--") || tag.startsWith("<?") || tag.startsWith("<![CDATA[")) continue;
    if (tag.startsWith("</")) {
      const name = /^<\/\s*([^\s>]+)/.exec(tag)?.[1];
      if (!name) continue;
      const index = stack.map((item) => item.name).lastIndexOf(name);
      if (index >= 0) stack.splice(index);
      continue;
    }
    if (tag.startsWith("<!")) continue;
    const name = /^<\s*([^\s/>]+)/.exec(tag)?.[1];
    if (!name) continue;
    const attrs = parseXmlAttributes(tag.slice(name.length + 1));
    const parent = stack.at(-1);
    const value = attrs.value ?? attrs.label ?? parent?.value;
    const id = attrs.id ?? parent?.id;
    if (name === "mxCell" && id) {
      if (attrs.vertex === "1") {
        const label = cleanDiagramLabel(value ?? "");
        addNode(graph, nodeFromLabel(id, label || id));
      } else if (attrs.edge === "1" && attrs.source && attrs.target) {
        const style = attrs.style ?? "";
        const startArrow = /(?:^|;)startArrow=([^;]*)/i.exec(style)?.[1]?.toLowerCase();
        const endArrow = /(?:^|;)endArrow=([^;]*)/i.exec(style)?.[1]?.toLowerCase();
        const hasExplicitArrowStyle = /(?:^|;)(?:startArrow|endArrow)=/i.test(style);
        const hasStartArrow = Boolean(startArrow && startArrow !== "none");
        const hasEndArrow = Boolean(endArrow && endArrow !== "none");
        if (hasExplicitArrowStyle && !hasStartArrow && !hasEndArrow) continue;
        if (hasStartArrow && !hasEndArrow) {
          addEdge(graph, attrs.target, attrs.source);
        } else {
          addEdge(graph, attrs.source, attrs.target);
          if (hasStartArrow && hasEndArrow) {
            addEdge(graph, attrs.target, attrs.source);
          }
        }
      }
    }
    if (!tag.endsWith("/>")) stack.push({ name, value, id });
  }
  return graph;
}

function parseDrawioSvg(source: string): ArchitectureGraph {
  if (/<\s*!DOCTYPE|<\s*!ENTITY/i.test(source)) {
    throw new DiagramParseError("Draw.io SVG with DTD or entity declarations is not supported.");
  }
  const tags = source.match(/<[^>]+>/g) ?? [];
  for (const tag of tags) {
    const attrs = parseXmlAttributes(tag.slice(1));
    const content = attrs.content;
    if (content && /mxfile|mxGraphModel/i.test(content)) return parseDrawio(content);
  }
  const encodedXml = /&lt;(?:mxfile|mxGraphModel)\b[\s\S]*?&gt;[\s\S]*?&lt;\/(?:mxfile|mxGraphModel)&gt;/i.exec(source)?.[0];
  if (encodedXml) return parseDrawio(decodeXmlText(encodedXml));
  throw new DiagramParseError("The SVG does not contain embedded Draw.io XML.");
}

function parseC4(source: string, graph: ArchitectureGraph): void {
  const nodeFunctions = new Set([
    "Person", "Person_Ext", "System", "System_Ext", "SystemDb", "SystemDb_Ext",
    "SystemQueue", "SystemQueue_Ext", "Container", "Container_Ext", "ContainerDb",
    "ContainerDb_Ext", "ContainerQueue", "ContainerQueue_Ext", "Container_Boundary",
    "Component", "Component_Ext", "ComponentDb", "ComponentDb_Ext", "ComponentQueue",
    "ComponentQueue_Ext", "System_Boundary", "Component_Boundary", "Deployment_Node",
    "Deployment_Node_Ext", "Deployment_Node_L", "Deployment_Node_R", "Deployment_Node_U",
    "Deployment_Node_D"
  ]);
  const calls = /\b([A-Za-z_]\w*)\s*\(([^()]*)\)/g;
  for (const match of source.matchAll(calls)) {
    const functionName = match[1];
    const args = splitArguments(match[2]);
    if (nodeFunctions.has(functionName) && args.length >= 2) {
      const id = unquote(args[0]);
      const label = unquote(args[1]);
      if (id) addNode(graph, nodeFromLabel(id, label || id));
      continue;
    }
    if (!/^(?:Rel|Rel_Back|Rel_U|Rel_D|Rel_L|Rel_R|BiRel)$/.test(functionName) || args.length < 2) continue;
    const first = unquote(args[0]);
    const second = unquote(args[1]);
    if (!first || !second) continue;
    if (functionName === "Rel_Back") addEdge(graph, second, first);
    else addEdge(graph, first, second);
    if (functionName === "BiRel") addEdge(graph, second, first);
  }
}

function parseFlowNode(segment: string): ArchitectureNode | undefined {
  const value = segment.trim().replace(/^\|[^|]*\|\s*/, "").replace(/\s*:::.*$/, "").trim();
  if (!value || value.startsWith("&")) return undefined;
  const id = /^([A-Za-z_][\w-]*)/.exec(value)?.[1];
  if (!id) return undefined;
  const remainder = value.slice(id.length).trimStart();
  const label = readShapeLabel(remainder);
  return nodeFromLabel(id, label === undefined ? id : cleanDiagramLabel(label));
}

function readShapeLabel(value: string): string | undefined {
  const pairs: Array<[string, string]> = [["[", "]"], ["(", ")"], ["{", "}"]];
  const pair = pairs.find(([open]) => value.startsWith(open));
  const doubleParentheses = value.startsWith("((");
  const doubleBraces = value.startsWith("{{");
  const custom = value.startsWith(">") && value.includes("[");
  if (!pair && !doubleParentheses && !doubleBraces && !custom) return undefined;
  const open = custom ? "[" : doubleParentheses ? "((" : doubleBraces ? "{{" : pair?.[0] ?? "";
  const close = custom ? "]" : doubleParentheses ? "))" : doubleBraces ? "}}" : pair?.[1] ?? "";
  const start = custom ? value.indexOf("[") + 1 : open.length;
  let depth = doubleParentheses || doubleBraces ? 2 : 1;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (character === open[0]) depth += 1;
    else if (character === close[0]) {
      depth -= 1;
      if (depth === 0) return value.slice(start, index);
    }
  }
  return value.slice(start).replace(/["']$/, "");
}

function nodeFromLabel(id: string, rawLabel: string): ArchitectureNode {
  const label = cleanDiagramLabel(rawLabel);
  const globs: string[] = [];
  const displayLabel = label.replace(/\[([^\]]+)\]/g, (whole, candidate: string) => {
    const glob = candidate.trim();
    if (looksLikeGlob(glob)) {
      globs.push(glob.replace(/\\/g, "/"));
      return " ";
    }
    return whole;
  }).replace(/\s+/g, " ").trim();
  return { id, label: displayLabel || id, globs: [...new Set(globs)] };
}

function cleanDiagramLabel(value: string): string {
  return decodeXmlText(value)
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<\/?(?:b|strong|i|em|span|div|p|html)[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function looksLikeGlob(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.includes("*") || value.startsWith(".");
}

function addNode(graph: ArchitectureGraph, node: ArchitectureNode): void {
  const existing = graph.nodes.get(node.id);
  if (!existing) {
    graph.nodes.set(node.id, node);
    return;
  }
  graph.nodes.set(node.id, {
    id: node.id,
    label: existing.label === existing.id && node.label !== node.id ? node.label : existing.label,
    globs: [...new Set([...existing.globs, ...node.globs])]
  });
}

function addEdge(graph: ArchitectureGraph, from: string, to: string): void {
  if (!graph.nodes.has(from)) addNode(graph, nodeFromLabel(from, from));
  if (!graph.nodes.has(to)) addNode(graph, nodeFromLabel(to, to));
  graph.allowedEdges.add((from + "->" + to) as DirectedArchitectureEdge);
}

function mergeGraphs(graphs: ArchitectureGraph[]): ArchitectureGraph {
  const result = emptyGraph();
  for (const graph of graphs) {
    for (const node of graph.nodes.values()) addNode(result, node);
    for (const edge of graph.allowedEdges) result.allowedEdges.add(edge);
  }
  return result;
}

function emptyGraph(): ArchitectureGraph {
  return { nodes: new Map(), allowedEdges: new Set() };
}

function stripMermaidComment(line: string): string {
  return line.replace(/%%.*$/, "");
}

function splitArguments(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote = "";
  for (const character of value) {
    if ((character === '"' || character === "'") && (!quote || quote === character)) quote = quote ? "" : character;
    if (character === "," && !quote) {
      result.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "").trim();
}

function parseXmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) attributes[match[1]] = decodeXmlText(match[2] ?? match[3] ?? "");
  return attributes;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([\da-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, number: string) => String.fromCodePoint(Number(number)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function extractDrawioCompressedPayload(source: string): string | undefined {
  const match = /<diagram\b[^>]*>([\s\S]*?)<\/diagram\s*>/i.exec(source);
  const content = match?.[1]?.trim();
  return content && !/<mxGraphModel\b/i.test(content) ? content : undefined;
}

function hasCompressedDiagram(source: string): boolean {
  return [...source.matchAll(/<diagram\b[^>]*>([\s\S]*?)<\/diagram\s*>/gi)]
    .some((match) => {
      const content = match[1].trim();
      return content.length > 0 && !/<(?:mxGraphModel|mxfile)\b/i.test(content);
    });
}

function expandCompressedDiagrams(source: string): string {
  let expandedBytes = Buffer.byteLength(source, "utf8");
  return source.replace(/(<diagram\b[^>]*>)([\s\S]*?)(<\/diagram\s*>)/gi, (whole, open: string, body: string, close: string) => {
    const content = body.trim();
    if (!content || /<(?:mxGraphModel|mxfile)\b/i.test(content)) return whole;
    const replacement = open + inflateDrawioPayload(content) + close;
    expandedBytes += Buffer.byteLength(replacement, "utf8") - Buffer.byteLength(whole, "utf8");
    if (expandedBytes > MAX_EXPANDED_DIAGRAM_BYTES) {
      throw new Error("expanded diagram exceeds 5 MiB");
    }
    return replacement;
  });
}

function inflateDrawioPayload(payload: string): string {
  const inflated = inflateRawSync(Buffer.from(payload.replace(/\s+/g, ""), "base64"), {
    maxOutputLength: MAX_EXPANDED_DIAGRAM_BYTES
  }).toString("utf8");
  return decodeURIComponent(inflated);
}

function markdownSlug(heading: string): string {
  return heading.toLowerCase().replace(/<[^>]*>/g, "").replace(/[\x60*_~]/g, "")
    .trim().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
