import fs from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  parseArchitectureDiagram,
  parseDrawio,
  parseMarkdownMermaid,
  parseMermaid
} from "../../src/architecture/diagramParser";

describe("normalized architecture diagram parser", () => {
  it("parses Mermaid flowcharts, inline node globs, and directed edges", () => {
    const graph = parseMermaid([
      "flowchart LR",
      "%% a comment with A --> hidden",
      "A[\"Billing [src/billing/**]\"] --> B[\"Shared [src/shared/**]\"]",
      "C[\"Inventory [src/inventory/**]\"] -.-> B",
      "B ==> D[\"Platform [src/platform/**]\"]"
    ].join("\n"));
    expect(graph.nodes.size).toBe(4);
    expect(graph.nodes.get("A")).toEqual({ id: "A", label: "Billing", globs: ["src/billing/**"] });
    expect(graph.nodes.get("B")?.globs).toEqual(["src/shared/**"]);
    expect(graph.allowedEdges).toEqual(new Set(["A->B", "C->B", "B->D"]));
  });

  it("parses C4 node declarations and directed relationships", () => {
    const graph = parseMermaid([
      "C4Context",
      "Person(customer, \"Customer\")",
      "System(billing, \"Billing [src/billing/**]\")",
      "System(shared, \"Shared\")",
      "Rel(billing, shared, \"uses\")",
      "Rel_Back(customer, billing, \"receives\")"
    ].join("\n"));
    expect(graph.nodes.get("billing")).toEqual({ id: "billing", label: "Billing", globs: ["src/billing/**"] });
    expect(graph.allowedEdges).toEqual(new Set(["billing->shared", "billing->customer"]));
  });

  it("selects Mermaid blocks below a Markdown heading anchor", () => {
    const fence = String.fromCharCode(96).repeat(3);
    const markdown = [
      "# Overview", fence + "mermaid", "flowchart LR", "A --> B", fence,
      "## Architecture", fence + "mermaid", "flowchart LR", "Billing --> Shared", fence,
      "## Other", fence + "mermaid", "flowchart LR", "Hidden --> Node", fence
    ].join("\n");
    expect(parseMarkdownMermaid("README.md#architecture", markdown).allowedEdges).toEqual(new Set(["Billing->Shared"]));
  });

  it("parses Draw.io XML vertices, HTML labels, inline globs, and source-to-target edges", () => {
    const xml = '<mxGraphModel><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="billing" value="&lt;b&gt;Billing&lt;/b&gt;&lt;br&gt;[src/billing/**]" vertex="1" parent="1"/>' +
      '<mxCell id="shared" value="&lt;b&gt;Shared&lt;/b&gt;&lt;br&gt;[src/shared/**]" vertex="1" parent="1"/>' +
      '<mxCell id="edge" edge="1" source="billing" target="shared"/>' +
      '</root></mxGraphModel>';
    const graph = parseDrawio(xml);
    expect(graph.nodes.get("billing")).toEqual({ id: "billing", label: "Billing", globs: ["src/billing/**"] });
    expect(graph.nodes.get("shared")?.globs).toEqual(["src/shared/**"]);
    expect(graph.allowedEdges).toEqual(new Set(["billing->shared"]));
  });

  it("retains compressed Draw.io pages and reads embedded XML from Draw.io SVG", () => {
    const xml = '<mxGraphModel><root><mxCell id="n" value="Node" vertex="1"/></root></mxGraphModel>';
    const packed = deflateRawSync(Buffer.from(encodeURIComponent(xml))).toString("base64");
    expect(parseDrawio('<mxfile><diagram>' + packed + '</diagram></mxfile>').nodes.has("n")).toBe(true);
    const encoded = "&lt;mxfile&gt;&lt;diagram&gt;&lt;mxGraphModel&gt;&lt;root&gt;" +
      "&lt;mxCell id=&quot;svg-node&quot; value=&quot;SVG Node&quot; vertex=&quot;1&quot;/&gt;" +
      "&lt;/root&gt;&lt;/mxGraphModel&gt;&lt;/diagram&gt;&lt;/mxfile&gt;";
    expect(parseArchitectureDiagram("docs/architecture.drawio.svg", '<svg content="' + encoded + '"></svg>').nodes.has("svg-node")).toBe(true);
  });

  it("rejects DTD and external entity declarations", () => {
    expect(() => parseDrawio('<!DOCTYPE mxfile [<!ENTITY secret SYSTEM "file:///secret">]><mxfile/>'))
      .toThrow(/DTD or entity/);
  });

  it("keeps the project architecture Draw.io artifact parseable and connected", async () => {
    const xml = await fs.readFile(path.join(process.cwd(), "docs/intent-contract-architecture.drawio"), "utf8");
    const graph = parseDrawio(xml);
    expect(graph.nodes.has("runtime")).toBe(true);
    expect(graph.nodes.has("drift")).toBe(true);
    expect(graph.allowedEdges.size).toBeGreaterThanOrEqual(20);
    expect(graph.allowedEdges.has("diagram->parser")).toBe(true);
    expect(graph.allowedEdges.has("drift->findings")).toBe(true);
  });
});
