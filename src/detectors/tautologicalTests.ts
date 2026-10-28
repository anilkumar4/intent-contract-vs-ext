import type { DiffHunkLine, FileChange, Finding } from "./types";
import { makeFinding } from "./finding";

interface Token {
  value: string;
  kind: "identifier" | "string" | "number" | "punctuation";
  line: number;
  change: DiffHunkLine["kind"];
}

interface TestBlock {
  name: string;
  start: number;
  end: number;
  changed: boolean;
}

export function detectTautologicalTests(changes: FileChange[]): Finding[] {
  const findings: Finding[] = [];
  for (const change of changes) {
    const file = change.newFile ?? change.file;
    if (change.status === "D") continue;

    const isPyTest = file.endsWith(".py") && (/(?:^|\/)tests?\//.test(file) || /(?:test_.+\.py|.+_test\.py)$/.test(file));
    if (isPyTest && change.afterContent !== undefined) {
      const changedLines = new Set(change.additions.map((line) => line.newLine).filter((line): line is number => line !== undefined));
      const blocks = findPythonTestBlocks(change.afterContent, changedLines, change.status === "A");
      for (const block of blocks) {
        if (!block.changed) continue;
        if (!block.hasAssertion) {
          findings.push(makeFinding(
            "tautological_tests", file, "assertion_free_test", `def ${block.name}(): (contains no assertion)`, "error",
            `Assertion-Free Test: "${block.name}" contains no assertion`,
            block.line,
            "Add an assertion that verifies the behavior under test. Calling the implementation alone does not prove the expected result."
          ));
        }
      }
      continue;
    }

    if (!/\.(?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i.test(file)) continue;

    const analyses: Array<{ lines: DiffHunkLine[]; tokens: Token[]; blocks: TestBlock[]; changedNames: Set<string> }> = [];
    if (change.afterContent !== undefined) {
      const lines = contentLines(change.afterContent, change.additions, "new");
      const tokens = tokenize(lines);
      const changedNames = new Set<string>();
      if (change.beforeContent !== undefined) {
        const previousLines = contentLines(change.beforeContent, change.deletions, "old");
        for (const block of findTestBlocks(tokenize(previousLines))) {
          if (block.changed) changedNames.add(block.name);
        }
      }
      analyses.push({ lines, tokens, blocks: findTestBlocks(tokens), changedNames });
    } else {
      for (const hunk of change.hunks ?? []) {
        const lines = hunk.lines.filter((line) => line.kind !== "delete");
        const tokens = tokenize(lines);
        analyses.push({ lines, tokens, blocks: findTestBlocks(tokens), changedNames: new Set() });
      }
    }

    for (const { lines, tokens, blocks, changedNames } of analyses) {
      for (const block of blocks) {
        if (!block.changed && !changedNames.has(block.name)) continue;
        const body = tokens.slice(block.start, block.end + 1);
        const testLine = tokens[block.start - 1]?.line ?? tokens[block.start]?.line;
        if (!containsAssertion(body)) {
          const line = testLine ?? 1;
          findings.push(makeFinding(
            "tautological_tests", file, "assertion_free_test", evidenceAt(lines, line), "error",
            `Assertion-Free Test: "${block.name}" contains no assertion`,
            line,
            "Add an assertion that verifies the behavior under test. Calling the implementation alone does not prove the expected result."
          ));
          continue;
        }

        const mockedMethods = findMockedMethods(body);
        for (const mock of mockedMethods) {
          const directAssertion = findDirectMockAssertion(body, mock.key);
          if (!directAssertion) continue;
          findings.push(makeFinding(
            "tautological_tests", file, "self_mocking", evidenceAt(lines, directAssertion.line), "error",
            `Self-Mocking: test asserts the configured mock ${mock.key} directly`,
            directAssertion.line,
            "Assert the result of the real function under test instead of asserting the value returned by a mocked dependency."
          ));
        }
      }
    }
  }
  return dedupe(findings);
}

function findTestBlocks(tokens: Token[]): TestBlock[] {
  const blocks: TestBlock[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== "identifier" || !["it", "test"].includes(tokens[index].value)) continue;
    let openCall = index + 1;
    while (tokens[openCall]?.value === "." && tokens[openCall + 1]?.kind === "identifier") openCall += 2;
    if (tokens[openCall]?.value !== "(") continue;
    const closeCall = matchingIndex(tokens, openCall, "(", ")");
    if (closeCall < 0) continue;
    const arrow = findTopLevelArrow(tokens, openCall + 1, closeCall);
    if (arrow < 0) continue;
    let bodyOpen = arrow + 1;
    while (tokens[bodyOpen]?.value === ")") bodyOpen += 1;
    if (tokens[bodyOpen]?.value !== "{") continue;
    const bodyClose = matchingIndex(tokens, bodyOpen, "{", "}");
    if (bodyClose < 0 || bodyClose > closeCall) continue;
    const name = tokens[openCall + 1]?.kind === "string" ? tokens[openCall + 1].value : "test";
    blocks.push({
      name,
      start: bodyOpen + 1,
      end: bodyClose - 1,
      changed: tokens.slice(index, bodyClose + 1).some((token) => token.change === "add")
    });
    index = bodyClose;
  }
  return blocks;
}

function findTopLevelArrow(tokens: Token[], start: number, end: number): number {
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = start; index < end; index += 1) {
    const value = tokens[index].value;
    if (value === "(" ) round += 1;
    else if (value === ")") round -= 1;
    else if (value === "[") square += 1;
    else if (value === "]") square -= 1;
    else if (value === "{") curly += 1;
    else if (value === "}") curly -= 1;
    else if (value === "=>" && round === 0 && square === 0 && curly === 0) return index;
  }
  return -1;
}

function containsAssertion(tokens: Token[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== "identifier") continue;
    if (["expect", "assert", "assertThat"].includes(tokens[index].value) && tokens[index + 1]?.value === "(") return true;
    if (tokens[index].value === "assert" && tokens[index + 1]?.value === "." && tokens[index + 2]?.kind === "identifier" && tokens[index + 3]?.value === "(") return true;
  }
  return false;
}

function findMockedMethods(tokens: Token[]): Array<{ key: string }> {
  const methods: Array<{ key: string }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "spyOn" || tokens[index - 1]?.value !== "." || tokens[index + 1]?.value !== "(") continue;
    const close = matchingIndex(tokens, index + 1, "(", ")");
    if (close < 0) continue;
    const args = splitArguments(tokens.slice(index + 2, close));
    const receiver = normalizeExpression(args[0] ?? []);
    const method = args[1]?.length === 1 && args[1][0].kind === "string" ? args[1][0].value : "";
    if (!receiver || !method) continue;
    methods.push({ key: `${receiver}.${method}` });
  }
  return methods;
}

function findDirectMockAssertion(tokens: Token[], mockKey: string): { line: number } | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "expect" || tokens[index + 1]?.value !== "(") continue;
    const close = matchingIndex(tokens, index + 1, "(", ")");
    if (close < 0) continue;
    const target = tokens.slice(index + 2, close);
    const directKey = directMethodCall(target);
    if (directKey === mockKey) return { line: tokens[index].line };
  }
  return undefined;
}

function directMethodCall(tokens: Token[]): string | undefined {
  let start = 0;
  let end = tokens.length;
  while (tokens[start]?.value === "(") {
    const close = matchingIndex(tokens, start, "(", ")");
    if (close !== end - 1) break;
    start += 1;
    end -= 1;
  }
  let index = start;
  if (tokens[index]?.kind !== "identifier") return undefined;
  const parts = [tokens[index++].value];
  while (tokens[index]?.value === "." && tokens[index + 1]?.kind === "identifier") {
    parts.push(tokens[index + 1].value);
    index += 2;
  }
  if (parts.length < 2 || tokens[index]?.value !== "(") return undefined;
  const close = matchingIndex(tokens, index, "(", ")");
  if (close !== end - 1) return undefined;
  return `${parts.slice(0, -1).join(".")}.${parts.at(-1)}`;
}

function tokenize(lines: DiffHunkLine[]): Token[] {
  const source = lines.map((line) => `${line.text}\n`).join("");
  const metadata: Array<{ line: number; change: DiffHunkLine["kind"] }> = [];
  for (const line of lines) {
    const count = line.text.length + 1;
    for (let index = 0; index < count; index += 1) metadata.push({ line: line.newLine ?? line.oldLine ?? 1, change: line.kind });
  }
  const tokens: Token[] = [];
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    const line = metadata[index]?.line ?? 1;
    const change = metadata[index]?.change ?? "context";
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") { end += 2; continue; }
        if (source[end] === quote) { end += 1; break; }
        end += 1;
      }
      tokens.push({ value: source.slice(index + 1, Math.max(index + 1, end - 1)), kind: "string", line, change });
      index = end;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
      tokens.push({ value: source.slice(index, end), kind: "identifier", line, change });
      index = end;
      continue;
    }
    if (/\d/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[\w.]/.test(source[end])) end += 1;
      tokens.push({ value: source.slice(index, end), kind: "number", line, change });
      index = end;
      continue;
    }
    const operator = ["=>", "===", "!==", "==", "!="].find((candidate) => source.startsWith(candidate, index));
    tokens.push({ value: operator ?? char, kind: "punctuation", line, change });
    index += operator?.length ?? 1;
  }
  return tokens;
}

function contentLines(
  content: string,
  changedLines: Array<{ oldLine?: number; newLine?: number }>,
  side: "old" | "new"
): DiffHunkLine[] {
  const changed = new Set(changedLines.map((line) => side === "old" ? line.oldLine : line.newLine).filter((line): line is number => line !== undefined));
  return content.split(/\r?\n/).map((text, index) => ({
    kind: changed.has(index + 1) ? (side === "old" ? "delete" : "add") : "context",
    text,
    oldLine: index + 1,
    newLine: index + 1
  }));
}

function matchingIndex(tokens: Token[], openIndex: number, open: string, close: string): number {
  if (tokens[openIndex]?.value !== open) return -1;
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === open) depth += 1;
    else if (tokens[index].value === close && --depth === 0) return index;
  }
  return -1;
}

function splitArguments(tokens: Token[]): Token[][] {
  const args: Token[][] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === "(") round += 1;
    else if (value === ")") round -= 1;
    else if (value === "[") square += 1;
    else if (value === "]") square -= 1;
    else if (value === "{") curly += 1;
    else if (value === "}") curly -= 1;
    else if (value === "," && round === 0 && square === 0 && curly === 0) {
      args.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  args.push(tokens.slice(start));
  return args;
}

function normalizeExpression(tokens: Token[]): string {
  return tokens.map((token) => token.value).join("");
}

function evidenceAt(lines: DiffHunkLine[], line: number): string {
  const selected = lines.filter((item) => item.newLine === line && item.kind !== "context");
  const evidence = selected.length > 0 ? selected : lines.filter((item) => item.kind !== "context").slice(0, 4);
  return evidence.map((item) => `${item.kind === "add" ? "+" : " "} ${item.text}`).join("\n") || "Changed test content";
}

function dedupe(findings: Finding[]): Finding[] {
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()];
}

function findPythonTestBlocks(
  content: string,
  changedLines: Set<number>,
  addedFile: boolean
): Array<{ name: string; line: number; changed: boolean; hasAssertion: boolean }> {
  const lines = content.split(/\r?\n/);
  const codeLines = maskPythonCommentsAndStrings(content).split(/\r?\n/);
  const blocks: Array<{ name: string; line: number; changed: boolean; hasAssertion: boolean }> = [];
  let current: { name: string; line: number; indent: number; bodyLines: string[]; changed: boolean } | undefined;

  const finish = (): void => {
    if (!current) return;
    const hasAssertion = current.bodyLines.some((line) => /\b(?:assert|pytest\.raises)\b|\bself\.assert[A-Za-z_]*/.test(line));
    blocks.push({ name: current.name, line: current.line, changed: current.changed, hasAssertion });
    current = undefined;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const codeLine = codeLines[index] ?? "";
    const match = /^(\s*)(?:async\s+)?def\s+(test_[A-Za-z0-9_]*)\s*\(/.exec(codeLine);
    if (match) {
      finish();
      current = {
        name: match[2], line: index + 1, indent: match[1].length, bodyLines: [],
        changed: addedFile || changedLines.has(index + 1)
      };
    } else if (current) {
      if (codeLine.trim()) {
        const currentIndent = (/^\s*/.exec(rawLine)?.[0].length ?? 0);
        if (currentIndent <= current.indent) {
          finish();
        } else {
          if (changedLines.has(index + 1)) current.changed = true;
          current.bodyLines.push(codeLine);
        }
      } else if (changedLines.has(index + 1) && (/^\s*/.exec(rawLine)?.[0].length ?? 0) > current.indent) {
        current.changed = true;
      }
    }
  }
  finish();
  return blocks;
}

function maskPythonCommentsAndStrings(source: string): string {
  const chars = source.split("");
  let quote = "";
  let triple = false;
  let comment = false;
  let escaped = false;

  for (let index = 0; index < chars.length; index += 1) {
    const character = chars[index];
    if (comment) {
      if (character === "\n") comment = false;
      else chars[index] = " ";
      continue;
    }
    if (quote) {
      if (character === "\n" && !triple) {
        quote = "";
        escaped = false;
        continue;
      }
      if (escaped) {
        if (character !== "\n") chars[index] = " ";
        escaped = false;
        continue;
      }
      if (character === "\\") {
        chars[index] = " ";
        escaped = true;
        continue;
      }
      if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
        chars[index] = chars[index + 1] = chars[index + 2] = " ";
        index += 2;
        quote = "";
        triple = false;
        continue;
      }
      chars[index] = " ";
      if (!triple && character === quote) quote = "";
      continue;
    }
    if (character === "#") {
      chars[index] = " ";
      comment = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      triple = source.slice(index, index + 3) === character.repeat(3);
      const count = triple ? 3 : 1;
      for (let offset = 0; offset < count; offset += 1) chars[index + offset] = " ";
      index += count - 1;
    }
  }
  return chars.join("");
}
