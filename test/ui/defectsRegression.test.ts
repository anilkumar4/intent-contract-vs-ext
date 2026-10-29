import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class MockCodeAction {
    public command?: unknown;
    constructor(public title: string, public kind?: unknown) {}
  }
  class MockCodeLens {
    constructor(public range: unknown, public command?: { title: string; tooltip?: string; command?: string }) {}
  }
  class MockRange {
    constructor(public startLine: number, public startChar: number, public endLine: number, public endChar: number) {}
  }
  class MockDiagnostic {
    public source?: string;
    public code?: unknown;
    constructor(public range: unknown, public message: string, public severity?: unknown) {}
  }
  class MockEventEmitter {
    public event = vi.fn();
    public fire = vi.fn();
    public dispose = vi.fn();
  }

  return {
    CodeActionKind: { QuickFix: 1 },
    CodeAction: MockCodeAction,
    CodeLens: MockCodeLens,
    Range: MockRange,
    Diagnostic: MockDiagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    Uri: { file: (fsPath: string) => ({ scheme: "file", fsPath }) },
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, defaultValue: unknown) => defaultValue
      })
    },
    EventEmitter: MockEventEmitter
  };
});

import { IntentContractCodeActionProvider } from "../../src/ui/quickFix";
import { IntentContractCodeLensProvider } from "../../src/ui/codeLens";
import { readSession, writeSession, type ContractSession } from "../../src/state/session";
import { matchesPatterns } from "../../src/detectors/scope";
import * as vscode from "vscode";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("Defects Regression Suite (D1, D8, D11, D16)", () => {
  it("D1: QuickFix provider matches diagnostics with source 'Intent Contract'", () => {
    const provider = new IntentContractCodeActionProvider({
      getRoot: () => "/workspace",
      getFindings: () => [
        {
          id: "finding-1",
          detector: "scope",
          severity: "warning",
          file: "README.md",
          message: "File is outside permitted scope",
          evidence: "diff"
        }
      ]
    });

    const doc = {
      uri: vscode.Uri.file("/workspace/README.md")
    } as vscode.TextDocument;

    const diag = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 1),
      "File is outside permitted scope",
      vscode.DiagnosticSeverity.Warning
    );
    diag.source = "Intent Contract";

    const actions = provider.provideCodeActions(doc, new vscode.Range(0, 0, 0, 1), {
      diagnostics: [diag],
      only: undefined,
      triggerKind: 1
    });

    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].title).toContain("Add \"README.md\" to allowed scope");
  });

  it("D8: matchesPatterns supports negative exclusions to permit wildcard overrides", () => {
    const readOnlyWildcard = ["src/shared/**"];
    expect(matchesPatterns("src/shared/money.ts", readOnlyWildcard)).toBe(true);

    const withExclusion = ["src/shared/**", "!src/shared/money.ts"];
    expect(matchesPatterns("src/shared/money.ts", withExclusion)).toBe(false);
    expect(matchesPatterns("src/shared/other.ts", withExclusion)).toBe(true);
  });

  it("D11: CodeLens provider filters out waived findings when displaying active warnings", () => {
    const provider = new IntentContractCodeLensProvider(() => ({
      root: "/workspace",
      session: {
        activeContract: ".intent/test.yaml",
        baselineTreeHash: "abc",
        headSha: null,
        startedAt: new Date().toISOString()
      } as ContractSession,
      contract: {
        name: "test",
        intent: "test",
        scope: { modify: ["src/**"], read_only: [], modify_symbols: [] },
        forbid: [],
        allow_exceptions: true
      },
      findings: [
        {
          id: "waived-finding-1",
          detector: "scope",
          severity: "warning",
          file: "README.md",
          message: "Out of scope",
          evidence: "diff"
        }
      ],
      waivers: new Map([
        ["waived-finding-1", {
          id: "waived-finding-1",
          reason: "Approved doc update",
          timestamp: new Date().toISOString()
        }]
      ])
    }));

    const doc = {
      uri: vscode.Uri.file("/workspace/README.md")
    } as vscode.TextDocument;

    const lenses = provider.provideCodeLenses(doc);
    // Since finding is waived, no warning lens should appear
    const warningLens = lenses.find((l) => l.command?.title.includes("warning"));
    expect(warningLens).toBeUndefined();
  });

  it("D16: Session state write is atomic and corrupt state throws clear diagnostic error", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-session-d16-"));
    try {
      const session: ContractSession = {
        activeContract: ".intent/test.yaml",
        baselineTreeHash: "abc123456",
        headSha: "head123",
        startedAt: new Date().toISOString(),
        baselineRef: "refs/intent-contract/baselines/test"
      };

      await writeSession(tmpDir, session);
      const readBack = await readSession(tmpDir);
      expect(readBack).toBeDefined();
      expect(readBack?.activeContract).toBe(".intent/test.yaml");

      // Corrupt the file with trailing junk (simulating non-atomic overwrite)
      const sessionFile = path.join(tmpDir, ".intent", ".state.json");
      await fs.appendFile(sessionFile, " trailing invalid junk\n");

      await expect(readSession(tmpDir)).rejects.toThrow("Session state corrupt (.intent/.state.json)");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
