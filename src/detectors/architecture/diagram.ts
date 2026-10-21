import { inflateRawSync } from "node:zlib";

export interface DiagramNode {
  id: string;
  label: string;
}

export interface DiagramGraph {
  nodes: DiagramNode[];
  edges: Array<{ from: string; to: string }>;
  warnings: string[];
}

export function parseArchitectureDiagram(filePath: string, source: string): DiagramGraph {
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith(".mmd")) return parseMermaid(source);
  if (normalized.endsWith(".drawio") || normalized.endsWith(".dio")) return parseDrawio(source);
  if (normalized.endsWith(".drawio.svg")) return parseDrawioSvg(source);
  if (/\.md(?:#.*)?$/i.test(normalized)) return parseMarkdownMermaid(filePath, source);
  return { nodes: [], edges: [], warnings: [`Unsupported architecture diagram format: ${filePath}`] };
}

export function parseMarkdownMermaid(reference: string, markdown: string): DiagramGraph {
  const anchor = reference.includes("#") ? reference.slice(reference.indexOf("#") + 1) : "";
  const lines = markdown.split(/\r?\n/);
  const blocks: string[] = [];
  let sectionLevel = 0;
  let inSection = !anchor;
  let foundAnchor = !anchor;
  let inFence = false;
  let mermaidFence = false;
  let block: string[] = [];

  for (const line of lines) {
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
    const fence = /^\s*(`{3,}|~{3,})\s*([\w-]+)?\s*$/.exec(line);
    if (!fence) {
      if (inFence && mermaidFence) block.push(line);
      continue;
    }
    if (!inFence) {
      inFence = true;
      mermaidFence = (fence[2] ?? "").toLowerCase() === "mermaid";
      block = [];
    } else {
      if (mermaidFence && inSection) blocks.push(block.join("\n"));
      inFence = false;
      mermaidFence = false;
      block = [];
    }
  }

  if (inFence && mermaidFence && inSection) blocks.push(block.join("\n"));
  if (anchor && !foundAnchor) {
    return { nodes: [], edges: [], warnings: [`Markdown heading anchor “#${anchor}” was not found in ${reference.split("#")[0]}.`] };
  }
  if (blocks.length === 0) return { nodes: [], edges: [], warnings: [`No Mermaid code block was found in ${reference}.`] };
  return mergeGraphs(blocks.map(parseMermaid));
}

export function parseMermaid(source: string): DiagramGraph {
  const graph: DiagramGraph = { nodes: [], edges: [], warnings: [] };
  const nodes = new Map<string, DiagramNode>();
  const edges = new Set<string>();
  const firstLine = source.split(/\r?\n/).find((line) => line.trim() && !line.trimStart().startsWith("%%")) ?? "";
  if (!/^\s*(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b/i.test(firstLine)) {
    graph.warnings.push("Only Mermaid flowchart/graph diagrams with an explicit direction are supported.");
    return graph;
  }

  for (const originalLine of source.split(/\r?\n/)) {
    const line = originalLine.replace(/%%.*$/, "").trim();
    if (!line || /^\s*(?:flowchart|graph)\s+/i.test(line) || /^\s*(?:subgraph|end|direction|classDef|class|style|linkStyle|click|accTitle|accDescr|---)\b/i.test(line)) continue;
    const arrowPattern = /(<[-=.]+>|[-=.]+>)(?:\|[^|]*\|)?/g;
    const matches = [...line.matchAll(arrowPattern)];
    if (matches.length === 0) {
      for (const node of nodesInSegment(line)) addNode(nodes, node);
      continue;
    }

    let segmentStart = 0;
    let priorTarget: string | undefined;
    for (let index = 0; index <= matches.length; index += 1) {
      const match = matches[index];
      const segmentEnd = match?.index ?? line.length;
      const segment = line.slice(segmentStart, segmentEnd);
      const parsed = nodesInSegment(segment);
      const current = parsed[0];
      for (const node of parsed) addNode(nodes, node);
      if (priorTarget && current) {
        edges.add(`${priorTarget}\0${current.id}`);
        priorTarget = current.id;
      } else if (current) {
        priorTarget = current.id;
      }
      if (match) {
        const operator = match[0].replace(/\|[^|]*\|$/, "");
        if (operator.startsWith("<") && current) {
          const targetStart = segmentEnd + match[0].length;
          const nextSegment = line.slice(targetStart, matches[index + 1]?.index ?? line.length);
          const next = nodesInSegment(nextSegment)[0];
          if (next) edges.add(`${next.id}\0${current.id}`);
        }
        segmentStart = segmentEnd + match[0].length;
      }
    }
  }

  graph.nodes = [...nodes.values()];
  graph.edges = [...edges].filter((edge) => !edge.startsWith("\0") && !edge.endsWith("\0")).map((edge) => {
    const [from, to] = edge.split("\0");
    return { from, to };
  });
  return graph;
}

export function parseDrawio(source: string): DiagramGraph {
  if (/<\s*!DOCTYPE|<\s*!ENTITY/i.test(source)) {
    return { nodes: [], edges: [], warnings: ["Draw.io XML with DTD or entity declarations is not supported."] };
  }

  if (hasCompressedDiagram(source)) {
    try {
      return parseDrawio(expandCompressedDiagrams(source));
    } catch (error) {
      return { nodes: [], edges: [], warnings: ["Could not decompress Draw.io diagram: " + errorMessage(error)] };
    }
  }

  let xml = source;
  const embedded = extractDrawioCompressedPayload(source);
  if (embedded) {
    try {
      xml = inflateDrawioPayload(embedded);
    } catch (error) {
      return { nodes: [], edges: [], warnings: [`Could not decompress Draw.io diagram: ${errorMessage(error)}`] };
    }
  }
  if (!/<(?:mxfile|mxGraphModel)\b/i.test(xml)) {
    return { nodes: [], edges: [], warnings: ["Draw.io XML does not contain an mxfile or mxGraphModel root."] };
  }

  const graph: DiagramGraph = { nodes: [], edges: [], warnings: [] };
  const cells = new Map<string, { node?: DiagramNode; edge?: { from: string; to: string } }>();
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
    const inheritedValue = attrs.value ?? attrs.label ?? parent?.value;
    const inheritedId = attrs.id ?? parent?.id;
    if (name === "mxCell") {
      const id = inheritedId;
      if (id) {
        if (attrs.vertex === "1") {
          const label = decodeXmlText(inheritedValue ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
          cells.set(id, { node: { id, label: label || id } });
        } else if (attrs.edge === "1" && attrs.source && attrs.target) {
          const style = attrs.style ?? "";
          const startArrow = /(?:^|;)startArrow=([^;]*)/i.exec(style)?.[1];
          const endArrow = /(?:^|;)endArrow=([^;]*)/i.exec(style)?.[1];
          if (startArrow?.toLowerCase() === "none" && endArrow?.toLowerCase() === "none") continue;
          const reverse = Boolean(startArrow && startArrow.toLowerCase() !== "none" && (!endArrow || endArrow.toLowerCase() === "none"));
          const edge = reverse
            ? { from: attrs.target, to: attrs.source }
            : { from: attrs.source, to: attrs.target };
          cells.set(id, { edge });
          if (startArrow && startArrow.toLowerCase() !== "none" && endArrow && endArrow.toLowerCase() !== "none") {
            cells.set(id + ":reverse", { edge: { from: attrs.target, to: attrs.source } });
          }
        }
      }
    }
    if (!tag.endsWith("/>")) stack.push({ name, value: inheritedValue, id: inheritedId });
  }

  for (const cell of cells.values()) {
    if (cell.node) graph.nodes.push(cell.node);
    if (cell.edge) graph.edges.push(cell.edge);
  }
  return graph;
}

function parseDrawioSvg(source: string): DiagramGraph {
  if (/<\s*!DOCTYPE|<\s*!ENTITY/i.test(source)) {
    return { nodes: [], edges: [], warnings: ["Draw.io SVG with DTD or entity declarations is not supported."] };
  }
  const tags = source.match(/<[^>]+>/g) ?? [];
  for (const tag of tags) {
    const attrs = parseXmlAttributes(tag.slice(1));
    const content = attrs.content;
    if (content && /mxfile|mxGraphModel/i.test(content)) return parseDrawio(content);
  }
  return { nodes: [], edges: [], warnings: ["The SVG does not contain embedded Draw.io XML in a content attribute."] };
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
  return source.replace(/(<diagram\b[^>]*>)([\s\S]*?)(<\/diagram\s*>)/gi, (whole, open: string, body: string, close: string) => {
    const content = body.trim();
    if (!content || /<(?:mxGraphModel|mxfile)\b/i.test(content)) return whole;
    return open + inflateDrawioPayload(content) + close;
  });
}

function inflateDrawioPayload(payload: string): string {
  const inflated = inflateRawSync(Buffer.from(payload.replace(/\s+/g, ""), "base64")).toString("utf8");
  return decodeURIComponent(inflated);
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
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function nodesInSegment(segment: string): DiagramNode[] {
  const found: DiagramNode[] = [];
  const pattern = /([A-Za-z_][\w-]*)(?:\s*@\{[^}]*\}|\s*(\[([^\]]*)\]|\(([^()]*)\)|\{([^}]*)\}|\|([^|]*)\|))?/g;
  for (const match of segment.matchAll(pattern)) {
    const id = match[1];
    if (["subgraph", "end", "direction", "flowchart", "graph"].includes(id.toLowerCase())) continue;
    const label = [match[3], match[4], match[5], match[6]].find((value) => value !== undefined)?.replace(/["`]/g, "").replace(/<br\s*\/?\s*>/gi, " ").trim();
    found.push({ id, label: label || id });
  }
  return found;
}

function addNode(nodes: Map<string, DiagramNode>, node: DiagramNode): void {
  const existing = nodes.get(node.id);
  nodes.set(node.id, existing && existing.label !== existing.id && node.label === node.id ? existing : node);
}

function mergeGraphs(graphs: DiagramGraph[]): DiagramGraph {
  const nodes = new Map<string, DiagramNode>();
  const edges = new Map<string, { from: string; to: string }>();
  for (const graph of graphs) {
    for (const node of graph.nodes) addNode(nodes, node);
    for (const edge of graph.edges) edges.set(`${edge.from}\0${edge.to}`, edge);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], warnings: graphs.flatMap((graph) => graph.warnings) };
}

function markdownSlug(heading: string): string {
  return heading.toLowerCase().replace(/<[^>]*>/g, "").replace(/[`*_~]/g, "").trim().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
