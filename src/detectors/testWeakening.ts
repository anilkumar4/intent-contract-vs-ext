import type { DiffHunk, DiffHunkLine, Finding, FileChange } from "./types";
import { makeFinding } from "./finding";

type Language = "js" | "python";
type TokenKind = "identifier" | "number" | "string" | "punctuation";
type Side = "add" | "delete";

interface Token {
  value: string;
  kind: TokenKind;
  line: number;
  change: DiffHunkLine["kind"];
}

interface Assertion {
  language: Language;
  target: string;
  matcher: string;
  tier?: 1 | 2 | 3;
  args: Token[][];
  negated: boolean;
  line: number;
  changed: boolean;
  source: Token[];
  approxValue?: string;
  relativeTolerance?: number;
}

const tierOne = new Set([
  "toBe", "toEqual", "toStrictEqual", "toHaveBeenCalledWith", "toHaveBeenLastCalledWith", "toThrowError", "==", "!="
]);
const tierTwo = new Set([
  "toMatchObject", "toContain", "toContainEqual", "toBeCloseTo", "toBeGreaterThan", "toBeLessThan",
  "toHaveBeenCalledTimes", "in"
]);
const tierThree = new Set([
  "toBeDefined", "toBeTruthy", "toBeFalsy", "toHaveBeenCalled", "toBeInstanceOf", "is not None", "is None", "bool", "truthy"
]);

export function detectTestWeakening(changes: FileChange[]): Finding[] {
  const findings: Finding[] = [];
  const implementationChanged = changes.some((change) => {
    const candidate = change.newFile ?? change.file;
    return isImplementationFile(candidate);
  });

  for (const change of changes) {
    const file = change.status === "D" ? (change.oldFile ?? change.file) : (change.newFile ?? change.file);
    const normalized = normalizePath(file);

    if (/\.snap$/i.test(normalized) && (change.status === "M" || change.status === "D")) {
      const deleted = change.status === "D";
      findings.push(makeFinding(
        "test_weakening", normalized, deleted ? "snapshot_deleted" : "snapshot_modified", changeEvidence(change), "warning",
        deleted ? "Snapshot file was deleted" : "Snapshot file was modified",
        firstChangedLine(change),
        "Review the snapshot change against the intended behavior. Restore the previous snapshot unless the behavior change was explicitly approved and independently verified."
      ));
      continue;
    }

    if (!isTestFile(normalized)) continue;
    if (change.status === "D") {
      findings.push(makeFinding(
        "test_weakening", normalized, "deleted_test_file", `deleted test file: ${normalized}`, "error",
        "Test file was deleted",
        firstChangedLine(change),
        "Restore the deleted test file and preserve its coverage. If the tests are obsolete, document the reason and get explicit approval before removing them."
      ));
      continue;
    }
    if (change.status !== "M" && change.status !== "A") continue;

    const language = languageFor(normalized);
    if (!language) continue;
    const hunks = getHunks(change);

    for (const hunk of hunks) {
      const oldLines = hunk.lines.filter((line) => line.kind !== "add");
      const newLines = hunk.lines.filter((line) => line.kind !== "delete");
      const oldTokens = tokenize(oldLines, language);
      const newTokens = tokenize(newLines, language);

      if (change.status === "M") {
        const oldBlocks = countChangedTestBlocks(oldTokens, language, "delete");
        const newBlocks = countChangedTestBlocks(newTokens, language, "add");
        if (oldBlocks > newBlocks) {
          findings.push(makeFinding(
            "test_weakening", normalized, "net_test_block_loss", changedEvidence(hunk), "error",
            `Test block count decreased (${oldBlocks} removed, ${newBlocks} added)`,
            firstChangedLine(change, "delete"),
            "Restore the removed test block or replace it with an equally meaningful test. Fix the implementation instead of reducing test coverage."
          ));
        }

        const oldAssertions = countChangedAssertions(oldTokens, language, "delete");
        const newAssertions = countChangedAssertions(newTokens, language, "add");
        if (oldAssertions > newAssertions) {
          findings.push(makeFinding(
            "test_weakening", normalized, "net_assertion_loss", changedEvidence(hunk), "error",
            `Assertion count decreased (${oldAssertions} removed, ${newAssertions} added)`,
            firstChangedLine(change, "delete"),
            "Restore the removed assertions or replace them with equally strict checks. Fix the implementation rather than deleting test expectations."
          ));
        }
      }

      const addedAssertions = parseAssertions(newTokens, language, "add");
      for (const marker of findDisabledTests(newTokens, language)) {
        findings.push(makeFinding(
          "test_weakening", normalized, "disabled_test", evidenceAt(hunk, undefined, marker.line), "error",
          `Added skipped, focused, or disabled test marker: ${marker.label}`,
          marker.line,
          "Remove the skip, focus, or disable marker and keep the test running. If the test is genuinely blocked, explain the blocker and obtain approval rather than silently disabling coverage."
        ));
      }

      for (const assertion of addedAssertions.filter(isTriviallyTrue)) {
        findings.push(makeFinding(
          "test_weakening", normalized, "trivial_assertion", evidenceAt(hunk, undefined, assertion.line), "error",
          "Added a trivially true assertion that cannot detect a regression",
          assertion.line,
          "Replace the tautology with an assertion over the behavior under test and a meaningful expected result."
        ));
      }

      if (change.status === "M") {
        const oldAssertionsParsed = parseAssertions(oldTokens, language, "delete");
        const newAssertionsParsed = addedAssertions;
        emitMatcherDowngrades(findings, normalized, hunk, oldAssertionsParsed, newAssertionsParsed);
        emitNegationFlips(findings, normalized, hunk, oldAssertionsParsed, newAssertionsParsed);
        emitToleranceWidening(findings, normalized, hunk, oldAssertionsParsed, newAssertionsParsed);
        if (implementationChanged) emitExpectedValueChanges(findings, normalized, hunk, oldAssertionsParsed, newAssertionsParsed);
        emitInlineSnapshotChanges(findings, normalized, hunk, oldAssertionsParsed, newAssertionsParsed);
      }

      emitEmptyTestBlocks(findings, normalized, change, hunk, language);
    }
  }

  return findings;
}

function emitMatcherDowngrades(findings: Finding[], file: string, hunk: DiffHunk, oldAssertions: Assertion[], newAssertions: Assertion[]): void {
  for (const [before, after] of pairAssertions(oldAssertions, newAssertions, (left, right) =>
    left.target === right.target && left.tier !== undefined && right.tier !== undefined && right.tier > left.tier
  )) {
    findings.push(makeFinding(
      "test_weakening", file, "matcher_downgrade", pairEvidence(hunk, before, after), "error",
      `Matcher weakened from ${before.matcher} (Tier ${before.tier}) to ${after.matcher} (Tier ${after.tier})`,
      after.line,
      `Restore the original strict assertion from the diff and fix the implementation instead. The target expression is ${before.target}.`
    ));
  }
}

function emitNegationFlips(findings: Finding[], file: string, hunk: DiffHunk, oldAssertions: Assertion[], newAssertions: Assertion[]): void {
  for (const [before, after] of pairAssertions(oldAssertions, newAssertions, (left, right) =>
    left.target === right.target && (
      (left.matcher === right.matcher && left.negated !== right.negated) ||
      (left.language === "python" && right.language === "python" &&
        ["==", "!="].includes(left.matcher) && ["==", "!="].includes(right.matcher) && left.matcher !== right.matcher) ||
      (left.language === "python" && right.language === "python" &&
        ["is None", "is not None"].includes(left.matcher) && ["is None", "is not None"].includes(right.matcher) && left.matcher !== right.matcher)
    )
  )) {
    findings.push(makeFinding(
      "test_weakening", file, "assertion_negation_flip", pairEvidence(hunk, before, after), "error",
      `Assertion negation changed for ${before.target}`,
      after.line,
      "Restore the original assertion polarity unless the behavior change is intentional and approved; fix the implementation to satisfy the original expectation."
    ));
  }
}

function emitToleranceWidening(findings: Finding[], file: string, hunk: DiffHunk, oldAssertions: Assertion[], newAssertions: Assertion[]): void {
  for (const [before, after] of pairAssertions(oldAssertions, newAssertions, (left, right) =>
    left.target === right.target && left.matcher === "toBeCloseTo" && right.matcher === "toBeCloseTo" &&
    normalizeTokens(left.args[0] ?? []) === normalizeTokens(right.args[0] ?? []) &&
    effectiveJestPrecision(left) !== undefined && effectiveJestPrecision(right) !== undefined &&
    (effectiveJestPrecision(right) as number) < (effectiveJestPrecision(left) as number)
  )) {
    findings.push(makeFinding(
      "test_weakening", file, "numeric_tolerance_widened", pairEvidence(hunk, before, after), "error",
      `toBeCloseTo precision decreased (${effectiveJestPrecision(before)} -> ${effectiveJestPrecision(after)})`,
      after.line,
      "Restore the original precision or provide evidence for an approved tolerance change. Fix calculation errors in the implementation rather than widening the assertion."
    ));
  }

  for (const [before, after] of pairAssertions(oldAssertions, newAssertions, (left, right) =>
    left.language === "python" && right.language === "python" && left.matcher === "==" && right.matcher === "==" &&
    left.target === right.target && left.approxValue !== undefined && right.approxValue !== undefined &&
    left.approxValue === right.approxValue && left.relativeTolerance !== undefined && right.relativeTolerance !== undefined &&
    right.relativeTolerance > left.relativeTolerance
  )) {
    findings.push(makeFinding(
      "test_weakening", file, "numeric_tolerance_widened", pairEvidence(hunk, before, after), "error",
      `pytest.approx relative tolerance increased (${before.relativeTolerance} -> ${after.relativeTolerance})`,
      after.line,
      "Restore the original pytest.approx tolerance or justify an approved tolerance change. Correct the implementation rather than relaxing the expected range."
    ));
  }
}

function emitExpectedValueChanges(findings: Finding[], file: string, hunk: DiffHunk, oldAssertions: Assertion[], newAssertions: Assertion[]): void {
  for (const [before, after] of pairAssertions(oldAssertions, newAssertions, (left, right) => {
    if (left.target !== right.target || left.matcher !== right.matcher) return false;
    if (left.language === "js" && (left.matcher === "toBe" || left.matcher === "toEqual")) {
      const oldValue = primitiveLiteral(left.args[0]);
      const newValue = primitiveLiteral(right.args[0]);
      return oldValue !== undefined && newValue !== undefined && oldValue !== newValue;
    }
    if (left.language === "python" && left.matcher === "==") {
      const oldValue = primitiveLiteral(left.args[0]);
      const newValue = primitiveLiteral(right.args[0]);
      return oldValue !== undefined && newValue !== undefined && oldValue !== newValue;
    }
    return false;
  })) {
    const oldValue = primitiveLiteral(before.args[0]) as string;
    const newValue = primitiveLiteral(after.args[0]) as string;
    findings.push(makeFinding(
      "test_weakening", file, "expected_value_changed_with_implementation", pairEvidence(hunk, before, after), "error",
      `Test expected value was altered alongside implementation changes (${oldValue} -> ${newValue}). Verify the agent didn't change the test to match a bug.`,
      after.line,
      `Restore the original expected value ${oldValue} in ${file}:${before.line} and fix the implementation instead.`
    ));
  }
}

function emitInlineSnapshotChanges(findings: Finding[], file: string, hunk: DiffHunk, oldAssertions: Assertion[], newAssertions: Assertion[]): void {
  for (const [before, after] of pairAssertions(oldAssertions, newAssertions, (left, right) =>
    left.target === right.target && left.matcher === "toMatchInlineSnapshot" && right.matcher === "toMatchInlineSnapshot" &&
    normalizeTokens(left.args[0] ?? []) !== normalizeTokens(right.args[0] ?? [])
  )) {
    findings.push(makeFinding(
      "test_weakening", file, "inline_snapshot_changed", pairEvidence(hunk, before, after), "warning",
      "Existing inline snapshot content was replaced",
      after.line,
      "Review the inline snapshot against the intended output and restore the old snapshot unless the behavior change was explicitly approved."
    ));
  }
}

function findDisabledTests(tokens: Token[], language: Language): Array<{ label: string; line: number }> {
  const markers: Array<{ label: string; line: number }> = [];
  if (language === "js") {
    const known = ["it.skip", "test.skip", "describe.skip", "it.only", "test.only", "describe.only", "xit", "xtest", "xdescribe", "it.todo", "test.todo", "it.concurrent.skip", "test.concurrent.skip"];
    for (let index = 0; index < tokens.length; index += 1) {
      for (const marker of known) {
        const sequence = marker.split(".");
        const values = sequence.flatMap((part, partIndex) => partIndex === 0 ? [part] : [".", part]);
        if (matchesAt(tokens, index, values) && tokens[index].kind === "identifier" && tokens[index + values.length]?.value === "(" && changedToken(tokens, index, index + values.length, "add")) {
          markers.push({ label: marker, line: changedLine(tokens, index, index + values.length, "add") ?? tokens[index].line });
        }
      }
    }
  } else {
    const pythonMarkers = [
      ["@", "pytest", ".", "mark", ".", "skip"],
      ["@", "pytest", ".", "mark", ".", "skipif"],
      ["@", "pytest", ".", "mark", ".", "xfail"],
      ["@", "unittest", ".", "skip"],
      ["@", "unittest", ".", "skipIf"],
      ["pytest", ".", "skip", "("]
    ];
    for (let index = 0; index < tokens.length; index += 1) {
      for (const marker of pythonMarkers) {
        if (matchesAt(tokens, index, marker) && changedToken(tokens, index, index + marker.length, "add")) {
          const label = marker.join("");
          markers.push({ label, line: changedLine(tokens, index, index + marker.length, "add") ?? tokens[index].line });
        }
      }
    }
  }
  return markers;
}

function emitEmptyTestBlocks(findings: Finding[], file: string, change: FileChange, hunk: DiffHunk, language: Language): void {
  const sourceLines = change.afterContent !== undefined
    ? change.afterContent.split(/\r?\n/).map((text, index) => ({ text, line: index + 1, kind: "context" as const }))
    : hunk.lines.filter((line) => line.kind !== "delete").map((line) => ({
        text: line.text,
        line: line.newLine ?? line.oldLine ?? 1,
        kind: line.kind
      }));
  const changedLines = new Set<number>();
  for (const line of hunk.lines) {
    if (line.kind !== "context") {
      const number = line.newLine ?? line.oldLine;
      if (number !== undefined) changedLines.add(number);
    }
  }
  const candidates = language === "js"
    ? findEmptyJavascriptTestBlocks(sourceLines, changedLines)
    : findEmptyPythonTestBlocks(sourceLines, changedLines);
  for (const line of candidates) {
    findings.push(makeFinding(
      "test_weakening", file, "empty_test_block", evidenceAt(hunk, undefined, line), "error",
      "Test block has no assertions and contains only pass or comments",
      line,
      "Restore meaningful assertions in this test block. Do not leave an empty test as a substitute for the removed coverage."
    ));
  }
}

function findEmptyJavascriptTestBlocks(lines: Array<{ text: string; line: number; kind: DiffHunkLine["kind"] }>, changedLines: Set<number>): number[] {
  const tokens = tokenize(lines, "js");
  const findings: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== "identifier" || !["it", "test"].includes(tokens[index].value)) continue;
    const open = findCallOpen(tokens, index + 1);
    if (open < 0) continue;
    const close = matchingIndex(tokens, open, "(", ")");
    if (close < 0) continue;
    let callbackStart = -1;
    for (let cursor = open + 1; cursor < close; cursor += 1) {
      if (tokens[cursor].value === "=>" || tokens[cursor].value === "function") {
        callbackStart = cursor;
        break;
      }
    }
    if (callbackStart < 0) continue;
    let bodyOpen = callbackStart + 1;
    while (bodyOpen < close && tokens[bodyOpen].value !== "{") bodyOpen += 1;
    if (bodyOpen >= close) continue;
    const bodyClose = matchingIndex(tokens, bodyOpen, "{", "}");
    if (bodyClose < 0) continue;
    const body = tokens.slice(bodyOpen + 1, bodyClose);
    if (body.some((token) => ![";"].includes(token.value))) continue;
    const headerLine = tokens[index].line;
    const bodyStartLine = tokens[bodyOpen].line;
    const bodyEndLine = tokens[bodyClose].line;
    if (![...changedLines].some((line) => line >= headerLine && line <= bodyEndLine && line >= bodyStartLine - 1)) continue;
    findings.push(headerLine);
  }
  return [...new Set(findings)];
}

function findEmptyPythonTestBlocks(lines: Array<{ text: string; line: number; kind: DiffHunkLine["kind"] }>, changedLines: Set<number>): number[] {
  const findings: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^(\s*)def\s+(test_[A-Za-z0-9_]*)\s*\(/.exec(lines[index].text);
    if (!header) continue;
    const indent = header[1].length;
    let end = index + 1;
    const body: string[] = [];
    while (end < lines.length) {
      const raw = lines[end].text;
      const trimmed = stripPythonLineComment(raw).trim();
      if (!trimmed) {
        end += 1;
        continue;
      }
      const lineIndent = /^\s*/.exec(raw)?.[0].length ?? 0;
      if (lineIndent <= indent) break;
      body.push(trimmed);
      end += 1;
    }
    if (body.some((statement) => statement !== "pass")) continue;
    const startLine = lines[index].line;
    const endLine = end > index + 1 ? lines[Math.min(end - 1, lines.length - 1)].line : startLine + 1;
    if (![...changedLines].some((line) => line >= startLine && line <= endLine)) continue;
    findings.push(startLine);
  }
  return [...new Set(findings)];
}

function parseAssertions(tokens: Token[], language: Language, side: Side): Assertion[] {
  return language === "js" ? parseJavascriptAssertions(tokens, side) : parsePythonAssertions(tokens, side);
}

function parseJavascriptAssertions(tokens: Token[], side: Side): Assertion[] {
  const assertions: Assertion[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "expect" || tokens[index + 1]?.value !== "(") continue;
    const targetEnd = matchingIndex(tokens, index + 1, "(", ")");
    if (targetEnd < 0) continue;
    const targetTokens = tokens.slice(index + 2, targetEnd);
    let cursor = targetEnd + 1;
    let negated = false;
    let matcher: string | undefined;
    let args: Token[][] = [];
    let end = targetEnd;
    while (tokens[cursor]?.value === "." && tokens[cursor + 1]?.kind === "identifier") {
      const name = tokens[cursor + 1].value;
      if (name === "not") {
        negated = !negated;
        cursor += 2;
        continue;
      }
      if (["resolves", "rejects", "eventually"].includes(name)) {
        cursor += 2;
        continue;
      }
      if (tokens[cursor + 2]?.value !== "(") break;
      const argsEnd = matchingIndex(tokens, cursor + 2, "(", ")");
      if (argsEnd < 0) break;
      matcher = name;
      args = splitArguments(tokens.slice(cursor + 3, argsEnd));
      end = argsEnd;
      break;
    }
    if (!matcher || !isKnownMatcher(matcher)) continue;
    const source = tokens.slice(index, end + 1);
    const changed = source.some((token) => token.change === side);
    if (!changed) continue;
    assertions.push({
      language: "js",
      target: normalizeTokens(targetTokens),
      matcher,
      tier: matcherTier(matcher),
      args,
      negated,
      line: changedLineIn(source, side) ?? tokens[index].line,
      changed,
      source
    });
  }
  return assertions;
}

function parsePythonAssertions(tokens: Token[], side: Side): Assertion[] {
  const assertions: Assertion[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "assert" || tokens[index - 1]?.value === ".") continue;
    let end = index + 1;
    let depth = 0;
    while (end < tokens.length) {
      const value = tokens[end].value;
      if (tokens[end].line > tokens[index].line && depth === 0) break;
      if (["(", "[", "{"].includes(value)) depth += 1;
      if ([")", "]", "}"].includes(value)) depth = Math.max(0, depth - 1);
      if (value === ";" && depth === 0) break;
      end += 1;
    }
    let expression = tokens.slice(index + 1, end);
    const comma = topLevelIndex(expression, ",");
    if (comma >= 0) expression = expression.slice(0, comma);
    let negated = false;
    if (expression[0]?.value === "not") {
      negated = true;
      expression = expression.slice(1);
    }
    const operatorIndex = findPythonOperator(expression);
    let targetTokens: Token[];
    let matcher: string;
    let args: Token[][];
    let approxValue: string | undefined;
    let relativeTolerance: number | undefined;

    if (operatorIndex >= 0) {
      const operator = pythonOperatorAt(expression, operatorIndex);
      targetTokens = expression.slice(0, operatorIndex);
      const right = expression.slice(operatorIndex + operator.width);
      matcher = operator.name;
      args = [right];
      if (matcher === "is not None") negated = true;
      if (matcher === "!=") negated = true;
      const approx = parsePytestApprox(right);
      if (approx) {
        approxValue = approx.expected;
        relativeTolerance = approx.relativeTolerance;
      }
    } else if (isCallExpression(expression, "bool")) {
      targetTokens = expression;
      matcher = "bool";
      args = [];
    } else {
      targetTokens = expression;
      matcher = "truthy";
      args = [];
    }
    const source = tokens.slice(index, end);
    const changed = source.some((token) => token.change === side);
    if (!changed) continue;
    assertions.push({
      language: "python",
      target: normalizeTokens(targetTokens),
      matcher,
      tier: matcherTier(matcher),
      args,
      negated,
      line: changedLineIn(source, side) ?? tokens[index].line,
      changed,
      source,
      ...(approxValue === undefined ? {} : { approxValue }),
      ...(relativeTolerance === undefined ? {} : { relativeTolerance })
    });
  }
  return assertions;
}

function findPythonOperator(tokens: Token[]): number {
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (depth === 0 && ["==", "!=", "in"].includes(value)) return index;
    if (depth === 0 && value === "is") return index;
    if (["(", "[", "{"].includes(value)) depth += 1;
    if ([")", "]", "}"].includes(value)) depth = Math.max(0, depth - 1);
  }
  return -1;
}

function pythonOperatorAt(tokens: Token[], index: number): { name: string; width: number } {
  if (tokens[index].value === "is" && tokens[index + 1]?.value === "not" && tokens[index + 2]?.value === "None") {
    return { name: "is not None", width: 3 };
  }
  if (tokens[index].value === "is" && tokens[index + 1]?.value === "None") return { name: "is None", width: 2 };
  return { name: tokens[index].value, width: 1 };
}

function parsePytestApprox(tokens: Token[]): { expected: string; relativeTolerance?: number } | undefined {
  if (!matchesAt(tokens, 0, ["pytest", ".", "approx", "("])) return undefined;
  const open = 3;
  const close = matchingIndex(tokens, open, "(", ")");
  if (close < 0) return undefined;
  const args = splitArguments(tokens.slice(open + 1, close));
  const expected = normalizeTokens(args[0] ?? []);
  let relativeTolerance: number | undefined;
  for (const arg of args.slice(1)) {
    const equals = arg.findIndex((token) => token.value === "=");
    if (equals > 0 && arg[equals - 1].value === "rel") {
      const value = Number(arg[equals + 1]?.value);
      if (Number.isFinite(value)) relativeTolerance = value;
    }
  }
  return { expected, ...(relativeTolerance === undefined ? {} : { relativeTolerance }) };
}

function isCallExpression(tokens: Token[], name: string): boolean {
  return tokens[0]?.value === name && tokens[1]?.value === "(" && matchingIndex(tokens, 1, "(", ")") === tokens.length - 1;
}

function isTriviallyTrue(assertion: Assertion): boolean {
  if (assertion.language === "js") {
    const actual = normalizeTokens(assertion.source.slice(2, matchingIndex(assertion.source, 1, "(", ")")));
    const expected = primitiveLiteral(assertion.args[0]);
    if (assertion.matcher === "toBeTruthy" && actual === "true") return true;
    return assertion.matcher === "toBe" && expected !== undefined && expected === actual && ["true", "false", "1"].includes(actual);
  }

  const actual = assertion.target;
  if (assertion.matcher === "truthy") return (!assertion.negated && actual === "True") || (assertion.negated && actual === "False");
  if (assertion.matcher === "==") {
    const expected = primitiveLiteral(assertion.args[0]);
    return !assertion.negated && expected !== undefined && expected === actual && ["True", "False", "1"].includes(actual);
  }
  return false;
}

function countChangedTestBlocks(tokens: Token[], language: Language, side: Side): number {
  let count = 0;
  if (language === "python") {
    for (let index = 0; index < tokens.length - 2; index += 1) {
      if (tokens[index].value === "def" && tokens[index + 1].kind === "identifier" && tokens[index + 1].value.startsWith("test_") && changedToken(tokens, index, index + 2, side)) count += 1;
    }
    return count;
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (!["it", "test", "describe", "xit", "xtest", "xdescribe"].includes(tokens[index].value)) continue;
    const open = findCallOpen(tokens, index + 1);
    if (open >= 0 && changedToken(tokens, index, open + 1, side)) count += 1;
  }
  return count;
}

function countChangedAssertions(tokens: Token[], language: Language, side: Side): number {
  let count = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (language === "js") {
      if ((value === "expect" || value === "expectTypeOf") && tokens[index + 1]?.value === "(" && changedToken(tokens, index, index + 2, side)) count += 1;
      else if (value === "assert" && tokens[index + 1]?.value === "." && changedToken(tokens, index, index + 2, side)) count += 1;
    } else {
      if (value === "assert" && tokens[index - 1]?.value !== "." && changedToken(tokens, index, index + 1, side)) count += 1;
      else if (value === "pytest" && matchesAt(tokens, index, ["pytest", ".", "raises", "("]) && changedToken(tokens, index, index + 4, side)) count += 1;
      else if (value === "self" && tokens[index + 1]?.value === "." && /^assert/.test(tokens[index + 2]?.value ?? "") && changedToken(tokens, index, index + 3, side)) count += 1;
    }
  }
  return count;
}

function pairAssertions(
  before: Assertion[],
  after: Assertion[],
  predicate: (left: Assertion, right: Assertion) => boolean
): Array<[Assertion, Assertion]> {
  const used = new Set<number>();
  const pairs: Array<[Assertion, Assertion]> = [];
  for (const left of before) {
    let best = -1;
    let distance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < after.length; index += 1) {
      if (used.has(index) || !predicate(left, after[index])) continue;
      const nextDistance = Math.abs(left.line - after[index].line);
      if (nextDistance < distance) {
        best = index;
        distance = nextDistance;
      }
    }
    if (best >= 0) {
      used.add(best);
      pairs.push([left, after[best]]);
    }
  }
  return pairs;
}

function getHunks(change: FileChange): DiffHunk[] {
  if (change.hunks?.length) return change.hunks;
  if (change.additions.length === 0 && change.deletions.length === 0) return [];
  return [{
    oldStart: change.deletions[0]?.oldLine ?? 1,
    newStart: change.additions[0]?.newLine ?? 1,
    lines: [...change.deletions, ...change.additions].map((line) => ({
      ...line,
      kind: line.kind
    }))
  }];
}

function tokenize(lines: Array<Pick<DiffHunkLine, "text" | "kind" | "oldLine" | "newLine">>, language: Language): Token[] {
  const source = lines.map((line) => line.text).join("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.text.length + 1;
  }
  const metadataAt = (position: number): { line: number; change: DiffHunkLine["kind"] } => {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle] <= position) low = middle + 1;
      else high = middle - 1;
    }
    const item = lines[Math.max(0, high)];
    return {
      line: item?.newLine ?? item?.oldLine ?? 1,
      change: item?.kind ?? "context"
    };
  };
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    if ((language === "js" && source.startsWith("//", index)) || (language === "python" && char === "#")) {
      const newline = source.indexOf("\n", index);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    const metadata = metadataAt(index);
    if (["'", "\"", "`"].includes(char)) {
      const start = index;
      const quote = char;
      const triple = language === "python" && source.slice(index, index + 3) === quote.repeat(3);
      const delimiter = triple ? quote.repeat(3) : quote;
      index += delimiter.length;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source.startsWith(delimiter, index)) {
          index += delimiter.length;
          break;
        }
        if (!triple && quote !== "`" && source[index] === "\n") break;
        index += 1;
      }
      tokens.push({ value: source.slice(start, index), kind: "string", ...metadata });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      tokens.push({ value: source.slice(start, index), kind: "identifier", ...metadata });
      continue;
    }
    if (/\d/.test(char)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_.]/.test(source[index])) index += 1;
      tokens.push({ value: source.slice(start, index), kind: "number", ...metadata });
      continue;
    }
    const operator = ["===", "!==", "...", "==", "!=", "=>", ">=", "<=", "?.", "**"].find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      tokens.push({ value: operator, kind: "punctuation", ...metadata });
      index += operator.length;
    } else {
      tokens.push({ value: char, kind: "punctuation", ...metadata });
      index += 1;
    }
  }
  return tokens;
}

function matchesAt(tokens: Token[], start: number, values: string[]): boolean {
  return values.every((value, offset) => tokens[start + offset]?.value === value);
}

function changedToken(tokens: Token[], start: number, end: number, side: Side): boolean {
  return tokens.slice(start, end).some((token) => token.change === side);
}

function changedLine(tokens: Token[], start: number, end: number, side: Side): number | undefined {
  return tokens.slice(start, end).find((token) => token.change === side)?.line;
}

function changedLineIn(tokens: Token[], side: Side): number | undefined {
  return tokens.find((token) => token.change === side)?.line;
}

function matchingIndex(tokens: Token[], openIndex: number, open: string, close: string): number {
  if (tokens[openIndex]?.value !== open) return -1;
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === open) depth += 1;
    else if (tokens[index].value === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findCallOpen(tokens: Token[], start: number): number {
  let index = start;
  while (tokens[index]?.value === "." && tokens[index + 1]?.kind === "identifier") index += 2;
  return tokens[index]?.value === "(" ? index : -1;
}

function splitArguments(tokens: Token[]): Token[][] {
  if (tokens.length === 0) return [];
  const args: Token[][] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === "(" ) round += 1;
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

function topLevelIndex(tokens: Token[], target: string): number {
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === target && round === 0 && square === 0 && curly === 0) return index;
    if (value === "(") round += 1;
    else if (value === ")") round -= 1;
    else if (value === "[") square += 1;
    else if (value === "]") square -= 1;
    else if (value === "{") curly += 1;
    else if (value === "}") curly -= 1;
  }
  return -1;
}

function isKnownMatcher(name: string): boolean {
  return tierOne.has(name) || tierTwo.has(name) || tierThree.has(name) || name === "toMatchInlineSnapshot";
}

function matcherTier(name: string): 1 | 2 | 3 | undefined {
  if (tierOne.has(name)) return 1;
  if (tierTwo.has(name)) return 2;
  if (tierThree.has(name)) return 3;
  return undefined;
}

function normalizeTokens(tokens: Token[]): string {
  return tokens.map((token) => token.value).join(" ").trim();
}

function primitiveLiteral(tokens: Token[] | undefined): string | undefined {
  if (!tokens) return undefined;
  if (tokens.length === 2 && ["-", "+"].includes(tokens[0].value) && tokens[1].kind === "number") {
    return `${tokens[0].value}${tokens[1].value}`;
  }
  if (tokens.length !== 1) return undefined;
  const token = tokens[0];
  if (token.kind === "number" || token.kind === "string") return token.value;
  if (token.kind === "identifier" && ["true", "false", "null", "True", "False", "None"].includes(token.value)) return token.value;
  return undefined;
}

function precision(tokens: Token[] | undefined): number | undefined {
  if (!tokens || tokens.length !== 1 || tokens[0].kind !== "number") return undefined;
  const value = Number(tokens[0].value);
  return Number.isFinite(value) ? value : undefined;
}

function effectiveJestPrecision(assertion: Assertion): number | undefined {
  if (assertion.args.length < 2 || assertion.args[1].length === 0) return 2;
  return precision(assertion.args[1]);
}

function changedEvidence(hunk: DiffHunk): string {
  const lines = hunk.lines.filter((line) => line.kind !== "context").slice(0, 8);
  return lines.length > 0 ? lines.map((line) => `${line.kind === "add" ? "+" : "-"} ${line.text}`).join("\n") : "Changed test content";
}

function evidenceAt(hunk: DiffHunk, oldLine?: number, newLine?: number): string {
  const selected = hunk.lines.filter((line) =>
    (line.kind === "delete" && oldLine !== undefined && line.oldLine === oldLine) ||
    (line.kind === "add" && newLine !== undefined && line.newLine === newLine)
  );
  const lines = selected.length > 0 ? selected : hunk.lines.filter((line) => line.kind !== "context").slice(0, 4);
  return lines.map((line) => `${line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "} ${line.text}`).join("\n") || "Changed test content";
}

function pairEvidence(hunk: DiffHunk, before: Assertion, after: Assertion): string {
  return evidenceAt(hunk, before.line, after.line);
}

function changeEvidence(change: FileChange): string {
  return [...change.deletions.slice(0, 4).map((line) => `- ${line.text}`), ...change.additions.slice(0, 4).map((line) => `+ ${line.text}`)].join("\n") || `File status: ${change.status}`;
}

function firstChangedLine(change: FileChange, side?: Side): number | undefined {
  if (side === "delete") return change.deletions[0]?.oldLine;
  if (side === "add") return change.additions[0]?.newLine;
  return change.additions[0]?.newLine ?? change.deletions[0]?.oldLine;
}

function isTestFile(file: string): boolean {
  const normalized = normalizePath(file).toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  const extension = /\.(?:js|jsx|ts|tsx|py)$/.test(normalized);
  if (!extension) return false;
  return /(?:^|\/)__tests__(?:\/|$)/.test(normalized) ||
    /\.(?:test|spec)\.(?:js|jsx|ts|tsx)$/.test(basename) ||
    /^test_.+\.py$/.test(basename) ||
    /^.+_test\.py$/.test(basename);
}

function isImplementationFile(file: string): boolean {
  const normalized = normalizePath(file).toLowerCase();
  if (!/\.(?:js|jsx|ts|tsx|py)$/.test(normalized) || isTestFile(normalized)) return false;
  if (normalized.split("/").some((part) => ["test", "tests", "__tests__", "node_modules", "dist", "coverage"].includes(part))) return false;
  return true;
}

function languageFor(file: string): Language | undefined {
  return file.toLowerCase().endsWith(".py") ? "python" : /\.(?:js|jsx|ts|tsx)$/i.test(file) ? "js" : undefined;
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function stripPythonLineComment(line: string): string {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === "\"") quote = char;
    else if (char === "#") return line.slice(0, index);
  }
  return line;
}
