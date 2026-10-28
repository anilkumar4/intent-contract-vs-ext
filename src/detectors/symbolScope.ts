import path from "node:path";
import picomatch from "picomatch";
import type { FileChange, Finding } from "./types";
import type { Contract } from "./types";
import { makeFinding } from "./finding";

interface SymbolRange {
  name: string;
  startLine: number;
  endLine: number;
}

export function detectSymbolScope(changes: FileChange[], contract: Contract): Finding[] {
  const allowedSymbols = new Set((contract.scope.modify_symbols ?? []).map((name) => name.trim()).filter(Boolean));
  if (allowedSymbols.size === 0) return [];
  const findings: Finding[] = [];

  for (const change of changes) {
    const file = (change.newFile ?? change.file).replace(/\\/g, "/");
    if (!matchesAny(file, contract.scope.modify) || !/\.(?:js|jsx|ts|tsx|py)$/i.test(file)) continue;

    const touched = new Map<string, { line: number; evidence: string }>();
    if (change.beforeContent !== undefined) {
      collectTouchedSymbols(change.beforeContent, change.deletions, "old", file, touched);
    }
    if (change.afterContent !== undefined) {
      collectTouchedSymbols(change.afterContent, change.additions, "new", file, touched);
    }
    if (change.beforeContent === undefined || change.afterContent === undefined) {
      for (const hunk of change.hunks ?? []) {
        const afterLines = hunk.lines.filter((line) => line.kind !== "delete");
        const beforeLines = hunk.lines.filter((line) => line.kind !== "add");
        if (change.afterContent === undefined) collectHunkSymbols(afterLines, hunk.newStart, "new", file, touched);
        if (change.beforeContent === undefined) collectHunkSymbols(beforeLines, hunk.oldStart, "old", file, touched);
      }
    }

    for (const [name, evidence] of touched) {
      if (isSymbolAllowed(name, file, allowedSymbols)) continue;
      findings.push(makeFinding(
        "symbol_scope", file, "symbol_not_allowed", evidence.evidence, "error",
        `Changed symbol "${name}" is not listed in scope.modify_symbols`,
        evidence.line,
        `Revert changes to ${name} or add it to scope.modify_symbols after obtaining approval to expand the symbol scope.`
      ));
    }
  }

  return findings;
}

function isSymbolAllowed(symbolName: string, file: string, allowedSymbols: Set<string>): boolean {
  if (allowedSymbols.has(symbolName)) return true;
  const normalizedFile = file.replace(/\\/g, "/");
  const baseName = path.posix.basename(normalizedFile);

  for (const allowed of allowedSymbols) {
    if (allowed.includes("::")) {
      const [allowedPath, allowedSymbol] = allowed.split("::");
      const pathMatches = picomatch.isMatch(normalizedFile, allowedPath, { dot: true }) ||
        normalizedFile.endsWith(allowedPath) ||
        baseName === allowedPath;
      if (pathMatches && (allowedSymbol === symbolName || symbolName.endsWith("." + allowedSymbol))) {
        return true;
      }
    } else if (allowed.includes(".")) {
      if (symbolName === allowed || symbolName.endsWith("." + allowed)) {
        return true;
      }
    }
  }
  return false;
}

function collectTouchedSymbols(
  source: string,
  changedLines: Array<{ text: string; oldLine?: number; newLine?: number }>,
  side: "old" | "new",
  file: string,
  output: Map<string, { line: number; evidence: string }>
): void {
  const ranges = findSymbols(source, file);
  for (const changed of changedLines) {
    const line = side === "old" ? changed.oldLine ?? changed.newLine : changed.newLine ?? changed.oldLine;
    if (line === undefined) continue;
    const owner = ranges
      .filter((range) => range.startLine <= line && range.endLine >= line)
      .sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine))[0];
    const name = owner ? owner.name : "<top_level>";
    const existing = output.get(name);
    const evidence = `${changed.text}`;
    if (!existing) output.set(name, { line, evidence });
    else if (!existing.evidence.includes(evidence)) existing.evidence += `\n${evidence}`;
  }
}

function collectHunkSymbols(
  lines: Array<{ text: string; oldLine?: number; newLine?: number; kind: "context" | "add" | "delete" }>,
  startLine: number,
  side: "old" | "new",
  file: string,
  output: Map<string, { line: number; evidence: string }>
): void {
  const source = lines.map((line) => line.text).join("\n");
  const ranges = findSymbols(source, file).map((range) => ({
    ...range,
    startLine: range.startLine + startLine - 1,
    endLine: range.endLine + startLine - 1
  }));
  for (const changed of lines.filter((line) => line.kind !== "context")) {
    const line = (side === "old" ? changed.oldLine ?? changed.newLine : changed.newLine ?? changed.oldLine) ?? startLine;
    const owner = ranges
      .filter((range) => range.startLine <= line && range.endLine >= line)
      .sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine))[0];
    const name = owner ? owner.name : "<top_level>";
    const existing = output.get(name);
    if (!existing) output.set(name, { line, evidence: changed.text });
    else if (!existing.evidence.includes(changed.text)) existing.evidence += `\n${changed.text}`;
  }
}

function findSymbols(source: string, file: string): SymbolRange[] {
  const masked = maskCommentsAndStrings(source, file.endsWith(".py") ? "python" : "js");
  const ranges: SymbolRange[] = [];
  if (file.endsWith(".py")) {
    const lines = source.split(/\r?\n/);
    let current: { name: string; indent: number; startLine: number } | undefined;
    let currentClass: { name: string; indent: number } | undefined;
    for (let index = 0; index < lines.length; index += 1) {
      const classMatch = /^(\s*)class\s+([A-Za-z_]\w*)/.exec(lines[index]);
      if (classMatch) {
        currentClass = { name: classMatch[2], indent: classMatch[1].length };
      } else if (currentClass && lines[index].trim() && (/^\s*/.exec(lines[index])?.[0].length ?? 0) <= currentClass.indent) {
        currentClass = undefined;
      }

      const match = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(lines[index]);
      if (match) {
        if (current) ranges.push({ ...current, endLine: index });
        const fnName = match[2];
        const qualifiedName = currentClass ? `${currentClass.name}.${fnName}` : fnName;
        current = { name: qualifiedName, indent: match[1].length, startLine: index + 1 };
        if (currentClass) {
          ranges.push({ name: fnName, startLine: index + 1, endLine: index + 1 });
        }
      } else if (current && lines[index].trim() && !/^\s*#/.test(lines[index]) && (/^\s*/.exec(lines[index])?.[0].length ?? 0) <= current.indent) {
        ranges.push({ ...current, endLine: index });
        current = undefined;
      }
    }
    if (current) ranges.push({ ...current, endLine: lines.length });
    return ranges;
  }

  const classPattern = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  for (let match = classPattern.exec(masked); match; match = classPattern.exec(masked)) {
    const className = match[1];
    const bodyOpen = masked.indexOf("{", match.index);
    if (bodyOpen < 0) continue;
    const bodyClose = matchingChar(masked, bodyOpen, "{", "}");
    if (bodyClose < 0) continue;
    const classBody = masked.slice(bodyOpen, bodyClose + 1);
    const methodPattern = /(?:(?:public|private|protected|static|readonly|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^={\n]+)?\s*\{/g;
    for (let m = methodPattern.exec(classBody); m; m = methodPattern.exec(classBody)) {
      if (["constructor", "if", "for", "while", "switch"].includes(m[1])) continue;
      const mOpen = bodyOpen + m.index + m[0].lastIndexOf("{");
      const mClose = matchingChar(masked, mOpen, "{", "}");
      if (mClose >= 0) {
        ranges.push({ name: m[1], startLine: lineAt(source, bodyOpen + m.index), endLine: lineAt(source, mClose) });
        ranges.push({ name: `${className}.${m[1]}`, startLine: lineAt(source, bodyOpen + m.index), endLine: lineAt(source, mClose) });
      }
    }
  }

  const functionPattern = /\b(?:export\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g;
  for (let match = functionPattern.exec(masked); match; match = functionPattern.exec(masked)) {
    const openParen = masked.indexOf("(", match.index + match[0].lastIndexOf(match[1]) + match[1].length);
    const closeParen = matchingChar(masked, openParen, "(", ")");
    if (closeParen < 0) continue;
    const bodyOpen = masked.indexOf("{", closeParen + 1);
    const bodyClose = bodyOpen < 0 ? -1 : matchingChar(masked, bodyOpen, "{", "}");
    if (bodyClose >= 0) ranges.push({ name: match[1], startLine: lineAt(source, match.index), endLine: lineAt(source, bodyClose) });
  }

  const arrowPattern = /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]+)?\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?\s*=>/g;
  for (let match = arrowPattern.exec(masked); match; match = arrowPattern.exec(masked)) {
    const arrowEnd = match.index + match[0].length;
    const bodyOpen = masked[arrowEnd] === "{" ? arrowEnd : -1;
    const bodyClose = bodyOpen < 0 ? expressionEnd(masked, arrowEnd) : matchingChar(masked, bodyOpen, "{", "}");
    if (bodyClose >= 0) ranges.push({ name: match[1], startLine: lineAt(source, match.index), endLine: lineAt(source, bodyClose) });
  }

  const topVarPattern = /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]+)?\s*=/g;
  for (let match = topVarPattern.exec(masked); match; match = topVarPattern.exec(masked)) {
    const varName = match[1];
    const line = lineAt(source, match.index);
    if (ranges.some((r) => r.startLine <= line && r.endLine >= line)) continue;
    if (braceDepthAt(masked, match.index) > 0) continue;
    if (!ranges.some((r) => r.name === varName)) {
      let endLine = line;
      const eqIndex = masked.indexOf("=", match.index);
      const afterEq = masked.slice(eqIndex + 1);
      const openBraceRel = afterEq.search(/\S/);
      if (openBraceRel >= 0 && afterEq[openBraceRel] === "{") {
        const openBrace = eqIndex + 1 + openBraceRel;
        const closeBrace = matchingChar(masked, openBrace, "{", "}");
        if (closeBrace >= 0) endLine = lineAt(source, closeBrace);
      } else {
        const end = expressionEnd(masked, eqIndex >= 0 ? eqIndex : match.index);
        endLine = lineAt(source, end);
      }
      ranges.push({ name: varName, startLine: line, endLine });
    }
  }

  return ranges;
}

function braceDepthAt(source: string, targetIndex: number): number {
  let depth = 0;
  for (let index = 0; index < targetIndex; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function maskCommentsAndStrings(source: string, language: "js" | "python"): string {
  const chars = source.split("");
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      else chars[index] = " ";
      continue;
    }
    if (blockComment) {
      if (char === "*" && chars[index + 1] === "/") {
        chars[index] = chars[index + 1] = " ";
        index += 1;
        blockComment = false;
      } else if (char !== "\n") chars[index] = " ";
      continue;
    }
    if (quote) {
      if (char !== "\n") chars[index] = " ";
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || (language === "js" && char === "`")) {
      quote = char;
      chars[index] = " ";
    } else if (language === "js" && char === "/" && chars[index + 1] === "/") {
      chars[index] = chars[index + 1] = " ";
      index += 1;
      lineComment = true;
    } else if (language === "js" && char === "/" && chars[index + 1] === "*") {
      chars[index] = chars[index + 1] = " ";
      index += 1;
      blockComment = true;
    } else if (language === "python" && char === "#") {
      chars[index] = " ";
      lineComment = true;
    }
  }
  return chars.join("");
}

function matchingChar(source: string, openIndex: number, open: string, close: string): number {
  if (source[openIndex] !== open) return -1;
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    else if (source[index] === close && --depth === 0) return index;
  }
  return -1;
}

function expressionEnd(source: string, start: number): number {
  const semicolon = source.indexOf(";", start);
  return semicolon < 0 ? source.length - 1 : semicolon;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (source[cursor] === "\n") line += 1;
  return line;
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => picomatch.isMatch(file, pattern.replace(/\\/g, "/"), { dot: true }));
}
