import {
  DiagramParseError,
  parseArchitectureDiagram as parseGraph,
  parseDrawio as parseDrawioGraph,
  parseMarkdownMermaid as parseMarkdownGraph,
  parseMermaid as parseMermaidGraph
} from "../../architecture/diagramParser";
import type { ArchitectureGraph } from "../../architecture/diagramParser";

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
  return legacyResult(() => parseGraph(filePath, source));
}

export function parseMarkdownMermaid(reference: string, markdown: string): DiagramGraph {
  return legacyResult(() => parseMarkdownGraph(reference, markdown));
}

export function parseMermaid(source: string): DiagramGraph {
  return legacyResult(() => parseMermaidGraph(source));
}

export function parseDrawio(source: string): DiagramGraph {
  return legacyResult(() => parseDrawioGraph(source));
}

function legacyResult(parse: () => ArchitectureGraph): DiagramGraph {
  try {
    const graph = parse();
    return {
      nodes: [...graph.nodes.values()].map(({ id, label }) => ({ id, label })),
      edges: [...graph.allowedEdges].map((edge) => {
        const separator = edge.indexOf("->");
        return { from: edge.slice(0, separator), to: edge.slice(separator + 2) };
      }),
      warnings: []
    };
  } catch (error) {
    return {
      nodes: [],
      edges: [],
      warnings: [error instanceof DiagramParseError ? error.message : String(error)]
    };
  }
}
