import { extractErrorMessage, InputError, SecurityError } from "../kernel/errors.ts";
import { redactSecretFileText } from "./secret-files.ts";
import { deepFreeze, sha256 } from "../kernel/integrity.ts";
import { redactLine, redactText, verifyRedaction, type RedactionResult } from "./redaction-engine.ts";
import {
  createPrivacyPolicy,
  type PrivacyPolicy,
} from "./privacy-policy.ts";

/**
 * File viewer — full/regex/semantic file viewing with in-place redaction.
 *
 * The file viewer is the model-facing repository inspection capability. It
 * reads a file through the trusted gateway and redacts detected credential
 * values before any egress. Credential presence alone does NOT reject the
 * whole authorized text — only the detected values are replaced.
 *
 * Unsupported parsing blocks semantic claims: if semantic mode is requested
 * but the file cannot be parsed (binary, unknown format, parse error), the
 * result is marked "unparseable" with a typed reason, NOT silently passed
 * or hidden.
 *
 * Layer: infrastructure (read-adapter, filesystem-read effect).
 * Owner: privacy-and-redaction.
 *
 * Binding authorities:
 * delivery map item 11
 * Canonical USR-055 / DER-041 / Gate 40
 * Root policy `modelRepositoryInspectionArchitecture`
 */

export type FileViewMode = "full" | "regex" | "semantic";

export type FileViewOptions = Readonly<{
  mode?: FileViewMode;
  pattern?: string;
  semanticQuery?: string;
  policy?: PrivacyPolicy;
  maxBytes?: number;
  maxLines?: number;
}>;

export type FileViewRedactionSummary = Readonly<{
  spanCount: number;
  redactionMapHash: string;
  verified: boolean;
  residualSpanCount: number;
}>;

/**
 * A REFUSAL HAS NO CONTENT FIELD, AND THAT IS THE POINT.
 *
 * The viewer used to answer a refusal with `content: ""` — the same shape a
 * successful view of an empty file has. A caller that read `.content` and
 * ignored the rest could not tell "nothing to show" from "we would not show
 * you this", and two of them did exactly that: the `read_file` tool and the
 * slice redactor both returned `view.content` unconditionally, so a file whose
 * redaction could not be verified reached the model as an EMPTY FILE. A safety
 * check that destroys instead of refusing reads downstream as success.
 *
 * So the refused variant does not carry content at all. `content` is
 * unreachable without narrowing on `outcome`, which makes ignoring a refusal a
 * compile error rather than a silent empty string — the strongest rung
 * available here, since the payload genuinely does not exist in this case.
 */
export type FileViewAdmitted = Readonly<{
  outcome: "viewed";
  path: string;
  mode: FileViewMode;
  content: string;
  contentHash: string;
  lineCount: number;
  byteLength: number;
  redactionSummary: FileViewRedactionSummary;
  parseStatus: "parsed" | "unparseable" | "not-attempted";
  blockReason?: string;
  truncated: boolean;
  matchedLineCount?: number;
}>;

export type FileViewRefused = Readonly<{
  outcome: "refused";
  path: string;
  mode: FileViewMode;
  redactionSummary: FileViewRedactionSummary;
  parseStatus: "not-attempted";
  /** Why nothing is being shown. Required — a refusal that cannot say why is
   * indistinguishable from a failure to answer. */
  blockReason: string;
  truncated: boolean;
}>;

export type FileViewResult = FileViewAdmitted | FileViewRefused;

export type FileRedactionDetail = Readonly<{
  line: number;
  result: RedactionResult;
}>;

// The viewer reads every limit from the RESOLVED policy at call time —
// `policy.maxFileBytes`, `policy.maxRegexPatternBytes`, `policy.maxMatchCount`
// and `policy.maxLines` — so a configured policy is always honoured. The
// second names this file used to keep for those defaults are gone: a local
// alias for a canonical constant is a second name for one value, and the line
// cap in particular was still being read from the DEFAULT while the other
// three had already moved to the policy.
const SUPPORTED_SEMANTIC_EXTENSIONS = deepFreeze([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json",
] as const);

/**
 * View a file with redaction applied. The file is read as UTF-8 text (fatal
 * decoder — invalid bytes block truthfully), and sensitive spans are
 * detected and replaced before the content is returned.
 *
 * Modes:
 * "full": read the entire file (within byte/line limits), redact, return.
 * "regex": show only lines matching a pattern, redacted.
 * "semantic": parse the file and show only relevant spans, redacted.
 * If parsing fails, the result is "unparseable" (not hidden or silently
 * passed).
 */
export function viewFile(
  path: string,
  content: string,
  options: FileViewOptions = {},
): FileViewResult {
  if (typeof path !== "string" || path.length === 0) {
    throw new InputError("viewFile: path must be a non-empty string", "file_viewer_path_empty");
  }
  if (typeof content !== "string") {
    throw new InputError("viewFile: content must be a string", "file_viewer_content_not_string");
  }
  const policy = options.policy ?? createPrivacyPolicy();
  // A secret file (by name) is viewed with every value redacted and its keys
  // visible — before any mode sees it, so no mode can show a value.
  content = redactSecretFileText(path, content, policy);
  const mode = options.mode ?? "full";
  const maxBytes = options.maxBytes ?? policy.maxFileBytes;
  const maxLines = options.maxLines ?? policy.maxLines;

  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    return blockedFileResult(
      path,
      mode,
      "file_viewer_oversize",
      content.slice(0, Math.min(content.length, maxBytes)),
      true,
    );
  }

  switch (mode) {
    case "full":
      return viewFull(path, content, policy, maxLines);
    case "regex":
      return viewRegex(path, content, options, policy, maxLines);
    case "semantic":
      return viewSemantic(path, content, options, policy, maxLines);
    default:
      throw new InputError(
        `viewFile: unknown mode '${String(mode)}'`,
        "file_viewer_unknown_mode",
      );
  }
}

function viewFull(
  path: string,
  content: string,
  policy: PrivacyPolicy,
  maxLines: number,
): FileViewResult {
  const lines = content.split("\n");
  const truncated = lines.length > maxLines;
  const effectiveLines = truncated ? lines.slice(0, maxLines) : lines;
  const effectiveContent = truncated
    ? effectiveLines.join("\n")
    : content;
  const result = redactText(effectiveContent, policy);
  const lineCount = truncated ? maxLines : lines.length;
  const verification = verifyRedaction(result.redactedText, policy);
  if (!verification.verified) {
    return blockedFileResult(path, "full", "redaction_incomplete_residual_secrets_detected", "", truncated, {
      spanCount: result.spanCount,
      redactionMapHash: result.redactionMapHash,
      residualSpanCount: verification.residualSpans.length,
    });
  }
  return deepFreeze({
    outcome: "viewed",
    path,
    mode: "full",
    content: result.redactedText,
    contentHash: sha256(result.redactedText),
    lineCount,
    byteLength: result.redactedByteLength,
    redactionSummary: deepFreeze({
      spanCount: result.spanCount,
      redactionMapHash: result.redactionMapHash,
      verified: verification.verified,
      residualSpanCount: verification.residualSpans.length,
    }),
    parseStatus: "not-attempted",
    ...(truncated ? { truncated: true } : { truncated: false }),
  });
}

/**
 * Compile a pattern the CALLER supplied, under the policy's bounds.
 *
 * Both pattern-taking view modes come through here, so neither can be the one
 * that forgets. They previously did not agree: regex mode capped the pattern's
 * size and turned a compile failure into a typed `file_viewer_regex_invalid`,
 * while semantic mode compiled `semanticQuery` with no size bound and no catch
 * of its own — a SyntaxError there fell into the mode's parse handler and was
 * reported as `parse_error`, blaming the FILE for a defect in the caller's
 * QUERY. The two answers are not interchangeable: one says fix your pattern,
 * the other says this file cannot be read.
 *
 * The size bound is not a defence against catastrophic backtracking — `(a+)+$`
 * is six bytes — and nothing here pretends otherwise. Callers that accept a
 * pattern from an untrusted source must run the MATCH somewhere it can be
 * killed; a bound on the pattern only stops a pathological COMPILE.
 */
function compileCallerPattern(
  pattern: string,
  policy: PrivacyPolicy,
  flags: string,
): RegExp {
  if (Buffer.byteLength(pattern, "utf8") > policy.maxRegexPatternBytes) {
    throw new SecurityError(
      "Regex pattern exceeds maximum size",
      "file_viewer_regex_pattern_oversize",
    );
  }
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new InputError(
      `Invalid regex pattern: ${extractErrorMessage(error)}`,
      "file_viewer_regex_invalid",
    );
  }
}

function viewRegex(
  path: string,
  content: string,
  options: FileViewOptions,
  policy: PrivacyPolicy,
  maxLines: number,
): FileViewResult {
  const pattern = options.pattern;
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new InputError(
      "viewFile regex mode requires a non-empty pattern",
      "file_viewer_regex_pattern_missing",
    );
  }
  const regex = compileCallerPattern(pattern, policy, "u");
  const lines = content.split("\n");
  const matchingLines: string[] = [];
  const matchingLineNumbers: number[] = [];
  const matchCap = Math.min(maxLines, policy.maxMatchCount);
  for (let i = 0; i < lines.length && matchingLines.length < matchCap; i += 1) {
    if (regex.test(lines[i]!)) {
      matchingLines.push(lines[i]!);
      matchingLineNumbers.push(i + 1);
    }
  }
  const redactedLines = matchingLines.map((line) => redactLine(line, policy));
  const totalSpans = redactedLines.reduce((sum, r) => sum + r.spanCount, 0);
  const redactionMapHash = sha256(
    redactedLines.map((r) => r.redactionMapHash).join("\n"),
  );
  const outputLines = redactedLines.map((r, i) => {
    const lineNum = String(matchingLineNumbers[i]!).padStart(6, " ");
    return `${lineNum}: ${r.redactedText}`;
  });
  const redactedContent = outputLines.join("\n");
  const regexTruncated = matchingLines.length >= matchCap && lines.length > matchCap;
  const verification = verifyRedaction(redactedContent, policy);
  if (!verification.verified) {
    return blockedFileResult(path, "regex", "redaction_incomplete_residual_secrets_detected", "", regexTruncated, {
      spanCount: totalSpans,
      redactionMapHash,
      residualSpanCount: verification.residualSpans.length,
    });
  }
  return deepFreeze({
    outcome: "viewed",
    path,
    mode: "regex",
    content: redactedContent,
    contentHash: sha256(redactedContent),
    lineCount: lines.length,
    byteLength: Buffer.byteLength(redactedContent, "utf8"),
    redactionSummary: deepFreeze({
      spanCount: totalSpans,
      redactionMapHash,
      verified: verification.verified,
      residualSpanCount: verification.residualSpans.length,
    }),
    parseStatus: "not-attempted",
    truncated: regexTruncated,
    matchedLineCount: matchingLines.length,
  });
}

function viewSemantic(
  path: string,
  content: string,
  options: FileViewOptions,
  policy: PrivacyPolicy,
  maxLines: number,
): FileViewResult {
  if (!policy.semanticModeEnabled) {
    return blockedFileResult(
      path,
      "semantic",
      "semantic_mode_disabled_before_qualification",
      "",
      false,
    );
  }
  const ext = getFileExtension(path);
  if (!SUPPORTED_SEMANTIC_EXTENSIONS.includes(ext as typeof SUPPORTED_SEMANTIC_EXTENSIONS[number])) {
    return unparseableFileResult(
      path,
      "semantic",
      `unsupported_file_extension:${ext}`,
      content,
      policy,
      maxLines,
    );
  }
  // Compiled OUTSIDE the parse handler below, and refused with the caller's own
  // error code. Inside it, an invalid query became `parse_error:` — a verdict
  // about the file, for a defect in the query.
  const semanticQuery = options.semanticQuery;
  const semanticRegex = semanticQuery === undefined || semanticQuery.length === 0
    ? undefined
    : compileCallerPattern(semanticQuery, policy, "u");
  try {
    const spans = extractSemanticSpans(content, ext, semanticRegex);
    // `maxContextLines`: cap the number of lines per semantic span to bound
    // output size. Spans exceeding the cap are truncated (with a marker).
    const contextCap = Math.max(1, policy.maxContextLines);
    const spanTexts = spans.map((span) => {
      const text = content.slice(span.start, span.end);
      const lines = text.split("\n");
      if (lines.length <= contextCap) return text;
      return lines.slice(0, contextCap).join("\n") + "\n... (truncated)";
    });
    const redactedResults = spanTexts.map((text) => redactText(text, policy));
    const totalSpans = redactedResults.reduce((sum, r) => sum + r.spanCount, 0);
    const redactionMapHash = sha256(
      redactedResults.map((r) => r.redactionMapHash).join("\n"),
    );
    const outputParts = redactedResults.map((r, i) => {
      const span = spans[i]!;
      return `-- span ${i + 1} [${span.start}:${span.end}] ${span.type} --\n${r.redactedText}`;
    });
    const redactedContent = outputParts.join("\n");
    const verification = verifyRedaction(redactedContent, policy);
    if (!verification.verified) {
      return blockedFileResult(path, "semantic", "redaction_incomplete_residual_secrets_detected", "", false, {
        spanCount: totalSpans,
        redactionMapHash,
        residualSpanCount: verification.residualSpans.length,
      });
    }
    return deepFreeze({
      outcome: "viewed",
      path,
      mode: "semantic",
      content: redactedContent,
      contentHash: sha256(redactedContent),
      lineCount: content.split("\n").length,
      byteLength: Buffer.byteLength(redactedContent, "utf8"),
      redactionSummary: deepFreeze({
        spanCount: totalSpans,
        redactionMapHash,
        verified: verification.verified,
        residualSpanCount: verification.residualSpans.length,
      }),
      parseStatus: "parsed",
      truncated: false,
      matchedLineCount: spans.length,
    });
  } catch (error) {
    return unparseableFileResult(
      path,
      "semantic",
      `parse_error:${extractErrorMessage(error)}`,
      content,
      policy,
      maxLines,
    );
  }
}

type SemanticSpan = Readonly<{
  start: number;
  end: number;
  type: string;
}>;

function extractSemanticSpans(
  content: string,
  ext: string,
  query?: RegExp,
): readonly SemanticSpan[] {
  if (ext === ".json") {
    return extractJsonSpans(content);
  }
  return extractCodeSpans(content, query);
}

function extractJsonSpans(content: string): readonly SemanticSpan[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new InputError(
      `JSON parse error: ${extractErrorMessage(error)}`,
      "file_viewer_json_parse_error",
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    return [{ start: 0, end: content.length, type: "value" }];
  }
  const spans: SemanticSpan[] = [];
  const regex = /"([^"\\]|\\.)*"\s*:/gu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const colonIndex = content.indexOf(":", match.index);
    if (colonIndex < 0) continue;
    const valueStart = colonIndex + 1;
    const valueEnd = findJsonValueEnd(content, valueStart);
    if (valueEnd > valueStart) {
      spans.push({ start: match.index, end: valueEnd, type: "property" });
    }
  }
  return spans;
}

function findJsonValueEnd(content: string, start: number): number {
  let i = start;
  while (i < content.length && content[i] === " ") i += 1;
  if (i >= content.length) return i;
  if (content[i] === '"') {
    i += 1;
    while (i < content.length) {
      if (content[i] === "\\") {
        i += 2;
        continue;
      }
      if (content[i] === '"') return i + 1;
      i += 1;
    }
    return content.length;
  }
  if (content[i] === "{") return findBracketEnd(content, i, "{", "}");
  if (content[i] === "[") return findBracketEnd(content, i, "[", "]");
  while (i < content.length && content[i] !== "," && content[i] !== "}" && content[i] !== "\n") {
    i += 1;
  }
  return i;
}

function findBracketEnd(content: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < content.length; i += 1) {
    if (content[i] === open) depth += 1;
    else if (content[i] === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return content.length;
}

/** The query arrives already compiled and already bounded — see
 *  `compileCallerPattern`. Compiling it here is what let an invalid pattern be
 *  reported as an unparseable FILE, and what left the only unbounded caller
 *  pattern in this module. */
function extractCodeSpans(content: string, regex?: RegExp): readonly SemanticSpan[] {
  if (regex === undefined) {
    return [{ start: 0, end: content.length, type: "full" }];
  }
  const spans: SemanticSpan[] = [];
  let match: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((match = regex.exec(content)) !== null) {
    if (match[0].length === 0) {
      if (regex.lastIndex === 0) break;
      regex.lastIndex += 1;
      continue;
    }
    spans.push({ start: match.index, end: match.index + match[0].length, type: "match" });
    if (!regex.global) break;
  }
  return spans;
}

function getFileExtension(path: string): string {
  const dotIndex = path.lastIndexOf(".");
  if (dotIndex < 0) return "";
  return path.slice(dotIndex).toLowerCase();
}

function blockedFileResult(
  path: string,
  mode: FileViewMode,
  reason: string,
  _content: string,
  truncated: boolean,
  redactionInfo?: Readonly<{ spanCount: number; redactionMapHash: string; residualSpanCount: number }>,
): FileViewRefused {
  return deepFreeze({
    outcome: "refused",
    path,
    mode,
    redactionSummary: deepFreeze({
      spanCount: redactionInfo?.spanCount ?? 0,
      redactionMapHash: redactionInfo?.redactionMapHash ?? sha256(""),
      verified: false,
      residualSpanCount: redactionInfo?.residualSpanCount ?? 0,
    }),
    parseStatus: "not-attempted",
    blockReason: reason,
    truncated,
  });
}

function unparseableFileResult(
  path: string,
  mode: FileViewMode,
  reason: string,
  content: string,
  policy: PrivacyPolicy,
  maxLines: number,
): FileViewResult {
  // `failClosedOnUncertainty`: when true (default), unparseable files return a
  // blocked result (no content egress). When false, the file gets best-effort
  // redaction (the redacted content is returned so the caller can inspect
  // non-sensitive structure, with the unparseable reason recorded).
  if (policy.failClosedOnUncertainty) {
    return blockedFileResult(path, mode, reason, "", false);
  }
  const lines = content.split("\n");
  const truncated = lines.length > maxLines;
  const effectiveLines = truncated ? lines.slice(0, maxLines) : lines;
  const effectiveContent = truncated ? effectiveLines.join("\n") : content;
  const result = redactText(effectiveContent, policy);
  const verification = verifyRedaction(result.redactedText, policy);
  if (!verification.verified) {
    return blockedFileResult(path, mode, "redaction_incomplete_residual_secrets_detected", "", truncated, {
      spanCount: result.spanCount,
      redactionMapHash: result.redactionMapHash,
      residualSpanCount: verification.residualSpans.length,
    });
  }
  return deepFreeze({
    outcome: "viewed",
    path,
    mode,
    content: result.redactedText,
    contentHash: sha256(result.redactedText),
    lineCount: truncated ? maxLines : lines.length,
    byteLength: result.redactedByteLength,
    redactionSummary: deepFreeze({
      spanCount: result.spanCount,
      redactionMapHash: result.redactionMapHash,
      verified: verification.verified,
      residualSpanCount: verification.residualSpans.length,
    }),
    parseStatus: "unparseable",
    blockReason: reason,
    truncated,
  });
}

export { SUPPORTED_SEMANTIC_EXTENSIONS };
