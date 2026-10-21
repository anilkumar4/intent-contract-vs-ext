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
