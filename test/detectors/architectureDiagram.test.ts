import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseArchitectureDiagram, parseDrawio, parseMarkdownMermaid, parseMermaid } from "../../src/detectors/architecture/diagram";

describe("architecture diagram parsers", () => {
  it("parses Mermaid node IDs, labels, chains, and explicitly bidirectional edges", () => {
    const graph = parseMermaid([
      "flowchart LR",
      "Billing[Billing Service] --> Shared[Shared Library] --> Inventory",
      "Billing <--> Inventory"
    ].join("\n"));
    expect(graph.nodes).toContainEqual({ id: "Billing", label: "Billing Service" });
    expect(graph.edges).toEqual(expect.arrayContaining([
      { from: "Billing", to: "Shared" },
      { from: "Shared", to: "Inventory" },
      { from: "Billing", to: "Inventory" },
      { from: "Inventory", to: "Billing" }
    ]));
  });

  it("selects Mermaid blocks under a Markdown heading anchor", () => {
    const markdown = [
      "# Overview",
      "~~~mermaid",
      "flowchart LR",
      "A --> B",
      "~~~",
      "## Architecture",
      "~~~mermaid",
      "flowchart LR",
      "Billing --> Shared",
      "~~~",
      "## Other",
      "~~~mermaid",
      "flowchart LR",
      "Hidden --> Node",
      "~~~"
    ].join("\n");
    const graph = parseMarkdownMermaid("README.md#architecture", markdown);
    expect(graph.edges, JSON.stringify(graph)).toEqual([{ from: "Billing", to: "Shared" }]);
  });

  it("parses Draw.io node labels and directed cell references", () => {
    const xml = '<mxfile><diagram><mxGraphModel><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<object id="billing" label="Billing"><mxCell vertex="1" parent="1"/></object>' +
      '<mxCell id="shared" value="Shared &amp; Common" vertex="1" parent="1"/>' +
      '<mxCell id="edge" edge="1" source="billing" target="shared"/>' +
      '<mxCell id="line" edge="1" source="shared" target="billing" style="startArrow=none;endArrow=none;"/>' +
      '</root></mxGraphModel></diagram></mxfile>';
    const graph = parseDrawio(xml);
    expect(graph.nodes).toEqual(expect.arrayContaining([
      { id: "billing", label: "Billing" },
      { id: "shared", label: "Shared & Common" }
    ]));
    expect(graph.edges).toEqual([{ from: "billing", to: "shared" }]);
  });

  it("decompresses Draw.io XML and rejects XML entity declarations", () => {
    const xml = '<mxfile><diagram><mxGraphModel><root><mxCell id="n" value="Node" vertex="1"/></root></mxGraphModel></diagram></mxfile>';
    const compressedXml = '<mxGraphModel><root><mxCell id="n" value="Node" vertex="1"/></root></mxGraphModel>';
    const secondCompressedXml = '<mxGraphModel><root><mxCell id="n2" value="Second" vertex="1"/></root></mxGraphModel>';
    const packed = deflateRawSync(Buffer.from(encodeURIComponent(compressedXml))).toString("base64");
    const packedSecond = deflateRawSync(Buffer.from(encodeURIComponent(secondCompressedXml))).toString("base64");
    expect(parseDrawio('<mxfile><diagram>' + packed + '</diagram><diagram>' + packedSecond + '</diagram></mxfile>').nodes)
      .toEqual([{ id: "n", label: "Node" }, { id: "n2", label: "Second" }]);
    expect(parseDrawio("<!DOCTYPE mxfile [<!ENTITY x SYSTEM 'file:///secret'>]>" + xml).warnings[0]).toMatch(/DTD or entity/);
  });

  it("reads embedded Draw.io XML from an SVG content attribute", () => {
    const embedded = "&lt;mxfile&gt;&lt;diagram&gt;&lt;mxGraphModel&gt;&lt;root&gt;" +
      "&lt;mxCell id=&quot;node&quot; value=&quot;Billing&quot; vertex=&quot;1&quot;/&gt;" +
      "&lt;/root&gt;&lt;/mxGraphModel&gt;&lt;/diagram&gt;&lt;/mxfile&gt;";
    const graph = parseArchitectureDiagram("docs/architecture.drawio.svg", '<svg content="' + embedded + '"></svg>');
    expect(graph.nodes).toEqual([{ id: "node", label: "Billing" }]);
  });
});
