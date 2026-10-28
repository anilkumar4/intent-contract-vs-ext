import { describe, expect, it } from "vitest";
import type { Contract } from "../../src/detectors/types";
import { detectSymbolScope } from "../../src/detectors/symbolScope";
import { parseUnifiedDiff } from "../../src/git/diff";

const contract: Contract = {
  name: "invoice-change",
  intent: "Update invoice proration",
  scope: {
    modify: ["billing/invoice.ts"],
    modify_symbols: ["calculateProration"],
    read_only: []
  },
  forbid: [],
  allow_exceptions: true
};

describe("symbol scope detector", () => {
  it("allows an edit to a symbol explicitly listed in modify_symbols", () => {
    const change = parseChangedFunction(
      "calculateProration",
      "return subtotal * oldRate;",
      "return subtotal * newRate;"
    );
    expect(detectSymbolScope([change], contract)).toEqual([]);
  });

  it("rejects edits to a different symbol in the same permitted file", () => {
    const change = parseChangedFunction(
      "chargeStripeCustomer",
      "return stripe.charge(oldAmount);",
      "return stripe.charge(newAmount);"
    );
    expect(detectSymbolScope([change], contract)).toContainEqual(expect.objectContaining({
      detector: "symbol_scope",
      rule: "symbol_not_allowed",
      severity: "error",
      file: "billing/invoice.ts",
      message: expect.stringContaining("chargeStripeCustomer")
    }));
  });

  it("recognises arrow functions with TypeScript return-type annotation", () => {
    const before = "export const describePlan = (name: string): string => {\n  return 'Plan: ' + name;\n};\n";
    const after = "export const describePlan = (name: string): string => {\n  return 'Changed: ' + name;\n};\n";
    const change = parseUnifiedDiff(
      "M\0billing/invoice.ts\0",
      "diff --git a/billing/invoice.ts b/billing/invoice.ts\n--- a/billing/invoice.ts\n+++ b/billing/invoice.ts\n@@ -2,1 +2,1 @@\n-  return 'Plan: ' + name;\n+  return 'Changed: ' + name;\n"
    ).changes[0];
    change.beforeContent = before;
    change.afterContent = after;
    const findings = detectSymbolScope([change], contract);
    expect(findings).toContainEqual(expect.objectContaining({
      detector: "symbol_scope",
      message: expect.stringMatching(/"describePlan"/)
    }));
  });

  it("covers top-level code outside any function (constants, config objects)", () => {
    const before = "export const TAX_RATE = 0.2;\nexport function calculateProration() { return 1; }\n";
    const after = "export const TAX_RATE = 0.25;\nexport function calculateProration() { return 1; }\n";
    const change = parseUnifiedDiff(
      "M\0billing/invoice.ts\0",
      "diff --git a/billing/invoice.ts b/billing/invoice.ts\n--- a/billing/invoice.ts\n+++ b/billing/invoice.ts\n@@ -1,1 +1,1 @@\n-export const TAX_RATE = 0.2;\n+export const TAX_RATE = 0.25;\n"
    ).changes[0];
    change.beforeContent = before;
    change.afterContent = after;
    const findings = detectSymbolScope([change], contract);
    expect(findings).toContainEqual(expect.objectContaining({
      detector: "symbol_scope"
    }));
  });

  it("recognises TypeScript/JavaScript class methods as symbols", () => {
    const before = "class InvoiceBuilder {\n  total(): number {\n    return 100;\n  }\n}\n";
    const after = "class InvoiceBuilder {\n  total(): number {\n    return 200;\n  }\n}\n";
    const change = parseUnifiedDiff(
      "M\0billing/invoice.ts\0",
      "diff --git a/billing/invoice.ts b/billing/invoice.ts\n--- a/billing/invoice.ts\n+++ b/billing/invoice.ts\n@@ -3,1 +3,1 @@\n-    return 100;\n+    return 200;\n"
    ).changes[0];
    change.beforeContent = before;
    change.afterContent = after;
    const findings = detectSymbolScope([change], contract);
    expect(findings).toContainEqual(expect.objectContaining({
      detector: "symbol_scope",
      message: expect.stringMatching(/total/)
    }));
  });

  it("scopes symbols per file or qualified (e.g. InvoiceBuilder.total, invoice.ts::prorate)", () => {
    const fileScopedContract: Contract = {
      name: "scoped",
      intent: "Scoping",
      scope: {
        modify: ["billing/**"],
        modify_symbols: ["billing/invoice.ts::prorate"],
        read_only: []
      },
      forbid: [],
      allow_exceptions: true
    };
    const otherBefore = "export function prorate() {\n  return 1;\n}\n";
    const otherAfter = "export function prorate() {\n  return 2;\n}\n";
    const otherChange = parseUnifiedDiff(
      "M\0billing/other.ts\0",
      "diff --git a/billing/other.ts b/billing/other.ts\n--- a/billing/other.ts\n+++ b/billing/other.ts\n@@ -2,1 +2,1 @@\n-  return 1;\n+  return 2;\n"
    ).changes[0];
    otherChange.beforeContent = otherBefore;
    otherChange.afterContent = otherAfter;
    const findings = detectSymbolScope([otherChange], fileScopedContract);
    expect(findings).toContainEqual(expect.objectContaining({
      detector: "symbol_scope",
      file: "billing/other.ts"
    }));
  });

  it("accepts changes to a local variable inside an allowed TypeScript function", () => {
    const prorateContract: Contract = {
      name: "prorate",
      intent: "Allow prorate",
      scope: {
        modify: ["src/billing/proration.ts"],
        modify_symbols: ["prorate"],
        read_only: []
      },
      forbid: [],
      allow_exceptions: true
    };
    const before = [
      "export function prorate(amount: number): number {",
      "  const base = amount * 1.0;",
      "  const ratio = 0.5;",
      "  return base * ratio;",
      "}",
      ""
    ].join("\n");
    const after = [
      "export function prorate(amount: number): number {",
      "  const base = amount * 1.0;",
      "  const ratio = 0.8;",
      "  return base * ratio;",
      "}",
      ""
    ].join("\n");
    const change = parseUnifiedDiff(
      "M\0src/billing/proration.ts\0",
      "diff --git a/src/billing/proration.ts b/src/billing/proration.ts\n--- a/src/billing/proration.ts\n+++ b/src/billing/proration.ts\n@@ -3,1 +3,1 @@\n-  const ratio = 0.5;\n+  const ratio = 0.8;\n"
    ).changes[0];
    change.beforeContent = before;
    change.afterContent = after;
    const findings = detectSymbolScope([change], prorateContract);
    expect(findings).toEqual([]);
  });
});

function parseChangedFunction(name: string, oldLine: string, newLine: string) {
  const source = `export function ${name}(amount: number) {\n  const subtotal = amount;\n  ${oldLine}\n}`;
  const current = source.replace(oldLine, newLine);
  const change = parseUnifiedDiff(
    "M\0billing/invoice.ts\0",
    `diff --git a/billing/invoice.ts b/billing/invoice.ts\n--- a/billing/invoice.ts\n+++ b/billing/invoice.ts\n@@ -1,4 +1,4 @@\n export function ${name}(amount: number) {\n   const subtotal = amount;\n-${oldLine}\n+${newLine}\n }\n`
  ).changes[0];
  change.beforeContent = source;
  change.afterContent = current;
  return change;
}
