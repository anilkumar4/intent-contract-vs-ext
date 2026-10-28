export type DetectorId = "scope" | "symbol_scope" | "dependencies" | "high_risk_files" | "test_weakening" | "tautological_tests" | "architecture_drift";
export type Severity = "error" | "warning";
export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U";

export interface Finding {
  id: string;
  detector: DetectorId;
  rule?: string;
  severity: Severity;
  file: string;
  line?: number;
  message: string;
  evidence: string;
  remediation?: string;
}

export interface Contract {
  name: string;
  intent: string;
  scope: {
    modify: string[];
    read_only: string[];
    modify_symbols?: string[];
  };
  architecture?: {
    diagram: string;
    node_mappings: Record<string, string[]>;
    default_policy: "deny_unlisted_edges";
  };
  high_risk?: {
    include?: string[];
    exclude?: string[];
  };
  forbid: Array<"new_dependencies" | "test_weakening" | "high_risk_files" | "architecture_drift">;
  allow_exceptions: boolean;
}

export interface DiffLine {
  kind: "add" | "delete";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunkLine {
  kind: "context" | "add" | "delete";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffHunkLine[];
}

export interface FileChange {
  status: ChangeStatus;
  file: string;
  oldFile?: string;
  newFile?: string;
  additions: DiffLine[];
  deletions: DiffLine[];
  hunks?: DiffHunk[];
  binary: boolean;
  beforeContent?: string;
  afterContent?: string;
}

export interface ParsedDiff {
  changes: FileChange[];
}
