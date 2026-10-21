export type DetectorId = "scope" | "dependencies" | "high_risk_files" | "test_weakening";
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
  };
  forbid: Array<"new_dependencies" | "test_weakening" | "high_risk_files">;
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
