/**
 * Pure helpers for the Per-File Complexity Badge (F111).
 *
 * A lightweight cyclomatic-complexity proxy that runs OFFLINE on a file
 * body without parsing the AST. The FileDecorationProvider calls this
 * once per visible file and stamps a one-letter badge in the explorer
 * (L / M / H / X = low / medium / high / extreme).
 *
 * Heuristic mix -- we score the SUM of:
 *
 *   - decision points     (if / else / for / while / case / catch / && / ||)
 *   - max nesting depth   (counts curly + paren depth peaks)
 *   - logical line count  (non-blank, non-comment)
 *   - function count      (declared + assigned + arrow)
 *
 * Each contributes weighted into a single complexity number. Buckets:
 *
 *   < 20    -> low
 *   < 60    -> medium
 *   < 150   -> high
 *   >= 150  -> extreme
 *
 * The heuristic is intentionally crude -- we want SCREEN-USEFUL bands,
 * not an exact metric. A real linter (eslint, sonar) would do this
 * properly; the FileDecoration is for "huh, that file is dense" at a
 * glance.
 *
 * Pure -- no fs, no vscode. Tests in test/git/complexityBadge.test.ts.
 */

export type ComplexityBucket = 'low' | 'medium' | 'high' | 'extreme';

export interface ComplexityScore {
  /** Single integer score used to bucket. */
  score: number;
  bucket: ComplexityBucket;
  /** Per-axis values, useful for the tooltip. */
  decisions: number;
  maxNesting: number;
  logicalLines: number;
  functions: number;
}

const DECISION_PATTERNS: RegExp[] = [
  /\bif\s*\(/g,
  /\belse\s+if\s*\(/g,
  /\bfor\s*\(/g,
  /\bwhile\s*\(/g,
  /\bdo\s*\{/g,
  /\bcase\s+[^:]+:/g,
  /\bcatch\s*\(/g,
  /\?\?=?/g,             // ?? + ??=
  /\?\./g,               // optional chaining
  /\?\s*[^?:]+:/g,       // ternary -- approximate match avoiding `??`
  /&&/g,
  /\|\|/g,
];

const FN_PATTERNS: RegExp[] = [
  /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/g,                   // function foo(
  /\bfunction\s*\(/g,                                       // function(
  /(?:^|\s|=|\(|,)\s*\([^)]*\)\s*=>/g,                     // (x) =>
  /(?:^|\s|=|\(|,)\s*[A-Za-z_$][\w$]*\s*=>/g,              // x =>
  /\b(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/gm,    // method foo() {
];

/**
 * Compute the complexity score for a file body.
 *
 * Strips comments + strings before counting so a regex literal or a
 * commented-out block doesn't inflate the count. The strip is heuristic
 * (it doesn't handle nested template literals perfectly) but is sound
 * enough for the badge use-case.
 */
export function computeComplexity(body: string): ComplexityScore {
  const empty: ComplexityScore = {
    score: 0, bucket: 'low',
    decisions: 0, maxNesting: 0, logicalLines: 0, functions: 0,
  };
  if (!body) return empty;

  const stripped = stripCommentsAndStrings(body);
  const lines = stripped.split('\n');

  // Logical lines: non-blank, non-comment-only.
  let logicalLines = 0;
  for (const l of lines) {
    if (l.trim().length === 0) continue;
    logicalLines++;
  }

  // Decision points.
  let decisions = 0;
  for (const re of DECISION_PATTERNS) {
    const m = stripped.match(re);
    if (m) decisions += m.length;
  }

  // Functions.
  let functions = 0;
  for (const re of FN_PATTERNS) {
    const m = stripped.match(re);
    if (m) functions += m.length;
  }

  // Max nesting depth by curly bracket count per char.
  const maxNesting = computeMaxBraceDepth(stripped);

  const score = computeScore(decisions, maxNesting, logicalLines, functions);
  return {
    score,
    bucket: classifyBucket(score),
    decisions,
    maxNesting,
    logicalLines,
    functions,
  };
}

function computeScore(
  decisions: number,
  nesting: number,
  lines: number,
  functions: number,
): number {
  // Weights chosen empirically against this very repo's files:
  //   - decisions are the strongest predictor of branchy complexity
  //   - nesting is a multiplier that captures "deep, hard to read"
  //   - lines is a sub-linear contribution (length alone doesn't make
  //     complexity, but very long files DO score higher all else equal)
  //   - functions is a sub-linear positive (more functions usually means
  //     better-broken-up code, but a 50-fn file is still dense)
  const lineFactor = Math.sqrt(Math.max(0, lines)) * 0.6;
  const fnFactor = Math.sqrt(Math.max(0, functions)) * 1.2;
  const nestingFactor = Math.pow(Math.max(0, nesting), 1.2) * 1.5;
  return Math.round(decisions * 2 + nestingFactor + lineFactor + fnFactor);
}

export function classifyBucket(score: number): ComplexityBucket {
  if (score < 20) return 'low';
  if (score < 60) return 'medium';
  if (score < 150) return 'high';
  return 'extreme';
}

/** Single-char badge for the explorer; '' = no badge (low). */
export function badgeFor(bucket: ComplexityBucket): string {
  switch (bucket) {
    case 'low':     return '';
    case 'medium':  return 'M';
    case 'high':    return 'H';
    case 'extreme': return 'X';
  }
}

/** Tooltip top-line summary. */
export function describeComplexity(s: ComplexityScore): string {
  return `${capitalise(s.bucket)} complexity (score ${s.score})`;
}

function capitalise(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Build the markdown tooltip body. Caller wraps in a MarkdownString.
 */
export function buildComplexityTooltip(s: ComplexityScore): string {
  const lines: string[] = [];
  lines.push(`**${describeComplexity(s)}**`);
  lines.push('');
  lines.push(`- ${s.decisions} decision points`);
  lines.push(`- max nesting depth: ${s.maxNesting}`);
  lines.push(`- ${s.logicalLines} logical lines`);
  lines.push(`- ${s.functions} function${s.functions === 1 ? '' : 's'}`);
  lines.push('');
  if (s.bucket === 'extreme' || s.bucket === 'high') {
    lines.push('_Consider splitting this file into smaller modules._');
  }
  return lines.join('\n');
}

/**
 * Strip comments and string literals so the regex counts don't fire on
 * them. Handles:
 *   - // line comments
 *   - /* ... *\/ block comments
 *   - single, double, backtick strings
 *
 * Conservative: anything inside a string becomes spaces of the same length
 * (preserves line numbers), so future line-based heuristics still align
 * with the original file.
 *
 * Does NOT handle template-literal interpolation perfectly -- `${expr}`
 * is treated as part of the string and won't be counted. That's
 * acceptable for a complexity heuristic.
 */
export function stripCommentsAndStrings(body: string): string {
  const out: string[] = [];
  let i = 0;
  const n = body.length;
  let inString: '"' | "'" | '`' | null = null;
  let inBlockComment = false;
  let inLineComment = false;

  while (i < n) {
    const c = body[i];
    const next = i + 1 < n ? body[i + 1] : '';

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out.push('\n');
      } else {
        out.push(' ');
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        out.push('  ');
        i += 2;
      } else {
        out.push(c === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }

    if (inString) {
      // Escape sequence -- pass through as space (or newline).
      if (c === '\\' && i + 1 < n) {
        // c is '\\' (never a newline here), so always emit a space for it.
        out.push(' ');
        out.push(body[i + 1] === '\n' ? '\n' : ' ');
        i += 2;
        continue;
      }
      if (c === inString) {
        inString = null;
        out.push(' ');
        i++;
        continue;
      }
      out.push(c === '\n' ? '\n' : ' ');
      i++;
      continue;
    }

    // Top-level mode.
    if (c === '/' && next === '/') {
      inLineComment = true;
      out.push('  ');
      i += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      out.push('  ');
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c as any;
      out.push(' ');
      i++;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

/** Max brace nesting depth -- ignores parens because TS arrow functions
 *  open paren-only and that's not a "block". */
function computeMaxBraceDepth(stripped: string): number {
  let depth = 0;
  let max = 0;
  for (const c of stripped) {
    if (c === '{') {
      depth++;
      if (depth > max) max = depth;
    } else if (c === '}') {
      depth = Math.max(0, depth - 1);
    }
  }
  return max;
}

/**
 * Decide whether a given path is interesting for the complexity badge.
 * Skips:
 *   - non-source extensions (.png, .lock, generated, etc.)
 *   - dist/build/out/node_modules
 */
export function isAnalysableFile(rel: string): boolean {
  if (!rel) return false;
  if (/(?:^|\/)(?:node_modules|\.git|dist|build|out|out-test|coverage|\.next|\.nuxt|\.cache|\.parcel-cache)(?:\/|$)/.test(rel)) {
    return false;
  }
  const ext = rel.split('.').pop()?.toLowerCase() ?? '';
  const ok = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp',
    'cs', 'php', 'scala', 'dart', 'lua', 'elm', 'ml', 'fs',
  ]);
  return ok.has(ext);
}
