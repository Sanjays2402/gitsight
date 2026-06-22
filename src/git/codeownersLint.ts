/**
 * Pure helpers for the CODEOWNERS validator (F102).
 *
 * Lints a CODEOWNERS file body into a list of structured diagnostics
 * suitable for emission as `vscode.Diagnostic` items. The view layer
 * does the disk I/O and `vscode.languages.createDiagnosticCollection`
 * wiring; this module owns the rules.
 *
 * Diagnostic categories:
 *
 *   - invalid-owner       Owner token isn't a valid @user / @org/team
 *                          / email-shape. (`@` without a handle, or
 *                          a stray comma between owners, etc.)
 *   - empty-owner-list    Pattern with no owners. Valid as a "negation"
 *                          override but flagged at Info severity so the
 *                          author can confirm.
 *   - duplicate-pattern   Two rules with identical patterns. The second
 *                          silently wins by GitHub's last-match-wins
 *                          semantics; the first is dead code.
 *   - unreachable-rule    A rule whose pattern is fully shadowed by a
 *                          LATER rule's pattern (the later rule
 *                          matches a strict superset).
 *   - dead-pattern        Glob doesn't match any tracked file in the
 *                          repo (best-effort, fed by the view).
 *   - syntax-warning      Glob has characters that mean different
 *                          things in CODEOWNERS vs typical .gitignore
 *                          (e.g. `**` inside a basename, leading `!`
 *                          which CODEOWNERS doesn't support).
 *
 * Pure - no fs, no vscode. Tests in test/git/codeownersLint.test.ts.
 */

export type LintCategory =
  | 'invalid-owner'
  | 'empty-owner-list'
  | 'duplicate-pattern'
  | 'unreachable-rule'
  | 'dead-pattern'
  | 'syntax-warning';

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintFinding {
  category: LintCategory;
  severity: LintSeverity;
  /** 0-based line number in the CODEOWNERS file. */
  line: number;
  /** 0-based column where the relevant token starts on the line. */
  column: number;
  /** Length of the highlighted token (so a Range can be built). */
  length: number;
  /** Human-friendly explanation suitable for the Problems panel. */
  message: string;
  /** Optional hint surfaced as a code-action / quick-fix. */
  hint?: string;
}

export interface ParsedRule {
  /** Original line number (0-based). */
  line: number;
  /** Pattern token, verbatim from the file. */
  pattern: string;
  /** Column where the pattern starts (after any leading whitespace). */
  patternColumn: number;
  /** Owner tokens, in order. */
  owners: { value: string; column: number }[];
}

/**
 * Tokenise a CODEOWNERS body into structured rules with column info.
 * Comments (`# ...`) and blank lines are skipped but counted so line
 * numbers in findings stay accurate.
 *
 * The trailing-comment form (`pattern @owner # note`) is supported -
 * the comment is stripped from the rule but column info is retained
 * for what came before it.
 */
export function tokeniseCodeowners(body: string): ParsedRule[] {
  const rules: ParsedRule[] = [];
  const lines = (body ?? '').split('\n');
  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line];
    // Strip an inline comment (everything after a # that isn't escaped).
    let content = raw;
    const hashIdx = findUnescapedHash(raw);
    if (hashIdx >= 0) content = raw.slice(0, hashIdx);
    // Skip lines that are all-whitespace post-strip.
    if (!content.trim()) continue;

    // Walk tokens with column info.
    const tokens: { value: string; column: number }[] = [];
    let col = 0;
    while (col < content.length) {
      // Skip whitespace.
      while (col < content.length && /\s/.test(content[col])) col++;
      if (col >= content.length) break;
      const start = col;
      while (col < content.length && !/\s/.test(content[col])) col++;
      tokens.push({ value: content.slice(start, col), column: start });
    }
    if (!tokens.length) continue;
    const [first, ...rest] = tokens;
    rules.push({
      line,
      pattern: first.value,
      patternColumn: first.column,
      owners: rest,
    });
  }
  return rules;
}

function findUnescapedHash(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '#') continue;
    // Treat as comment only when preceded by whitespace or line-start.
    if (i === 0 || /\s/.test(s[i - 1])) return i;
  }
  return -1;
}

const HANDLE_RE = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;          // @user
const TEAM_RE   = /^@[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]*$/; // @org/team
const EMAIL_RE  = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export type OwnerKind = 'user' | 'team' | 'email' | 'invalid';

export function classifyOwner(token: string): OwnerKind {
  if (!token) return 'invalid';
  if (TEAM_RE.test(token)) return 'team';
  if (HANDLE_RE.test(token)) return 'user';
  if (EMAIL_RE.test(token)) return 'email';
  return 'invalid';
}

/**
 * Convert a CODEOWNERS glob into a regex for shadow-detection. Mirrors
 * the helper inside filesIOwn.ts; intentionally duplicated here so
 * this module stays free of cross-file imports (it should be drop-in
 * usable from a CodeAction provider too).
 */
export function codeownersGlobToRegex(pattern: string): RegExp | undefined {
  if (!pattern) return undefined;
  let p = pattern;
  // CODEOWNERS does NOT support leading `!` negation. The caller is
  // expected to flag those as syntax-warnings; we still return a
  // best-effort regex so shadow analysis can proceed.
  if (p.startsWith('!')) p = p.slice(1);
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        re += '.*';
        i++; // skip second *
        // Eat trailing slash from `**/`
        if (p[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') re += '[^/]';
    else if (/[.+^${}()|\[\]\\]/.test(ch)) re += '\\' + ch;
    else re += ch;
  }
  const prefix = anchored ? '^/' : '(^|/)';
  const suffix = dirOnly ? '(/|$)' : '($|/)';
  try {
    return new RegExp(prefix + re + suffix);
  } catch {
    return undefined;
  }
}

/**
 * Find dead rules — rules whose patterns aren't matched by any path
 * in the provided file list. Returns the line numbers of dead rules.
 * Pass an empty file list to skip this check entirely.
 */
export function findDeadPatterns(rules: ParsedRule[], files: string[]): number[] {
  if (!files.length) return [];
  const out: number[] = [];
  for (const rule of rules) {
    const re = codeownersGlobToRegex(rule.pattern);
    if (!re) continue;
    const hit = files.some(f => re.test('/' + f.replace(/^\/+/, '')));
    if (!hit) out.push(rule.line);
  }
  return out;
}

/**
 * Detect rules whose pattern is FULLY SHADOWED by a later rule (the
 * later rule matches everything the earlier rule matches). This is a
 * heuristic: we compare on string-equality for the pattern, plus a
 * shadowing-via-prefix heuristic (e.g. `src/api/*` shadowed by
 * `src/api/**`).
 */
export function findShadowedRules(rules: ParsedRule[]): { line: number; shadowedBy: number }[] {
  const out: { line: number; shadowedBy: number }[] = [];
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      if (rulesShadowed(rules[i].pattern, rules[j].pattern)) {
        out.push({ line: rules[i].line, shadowedBy: rules[j].line });
        break; // first shadowing rule is enough
      }
    }
  }
  return out;
}

/** True when patternB completely shadows patternA. */
function rulesShadowed(a: string, b: string): boolean {
  if (!a || !b) return false;
  // Exact pattern match: B wins by last-match-wins.
  if (a === b) return true;
  // `foo/*` is shadowed by `foo/**` and similar superset cases. We
  // do a conservative check: B equals A with a doubled-glob suffix
  // (e.g. `foo/*` -> `foo/**`).
  if (b === a.replace(/\/\*+$/, '/**')) return true;
  return false;
}

/**
 * Detect duplicate patterns (the second rule silently wins; the
 * first becomes dead code). Returns the line numbers of the EARLIER
 * rules.
 */
export function findDuplicatePatterns(rules: ParsedRule[]): { line: number; supersededBy: number }[] {
  const out: { line: number; supersededBy: number }[] = [];
  const seen = new Map<string, number>(); // pattern -> last-seen line
  // First pass: find the *last* line each pattern appears on.
  for (const r of rules) seen.set(r.pattern, r.line);
  // Second pass: every rule whose pattern's last-line is greater than
  // this rule's line is a duplicate.
  for (const r of rules) {
    const last = seen.get(r.pattern)!;
    if (last !== r.line) {
      out.push({ line: r.line, supersededBy: last });
    }
  }
  return out;
}

/**
 * The top-level linter. Composes every check and returns a sorted
 * list of findings (line ascending, then column ascending).
 *
 * `files` is the list of repo-relative tracked paths used for the
 * dead-pattern check. Pass an empty array to skip dead detection
 * (e.g. when the workspace doesn't have a usable git wrapper at lint
 * time).
 */
export function lintCodeowners(body: string, files: string[] = []): LintFinding[] {
  const rules = tokeniseCodeowners(body);
  const findings: LintFinding[] = [];

  // 1. Per-rule checks.
  for (const r of rules) {
    // Leading `!` is not supported.
    if (r.pattern.startsWith('!')) {
      findings.push({
        category: 'syntax-warning', severity: 'warning',
        line: r.line, column: r.patternColumn, length: r.pattern.length,
        message: 'CODEOWNERS does not support negation patterns (leading "!"). This rule is treated as a literal pattern starting with "!".',
        hint: 'Remove the leading `!` and structure the rule order so the more-specific pattern wins.',
      });
    }
    // Empty owner list - valid for explicit "no owner" but flag.
    if (r.owners.length === 0) {
      findings.push({
        category: 'empty-owner-list', severity: 'info',
        line: r.line, column: r.patternColumn, length: r.pattern.length,
        message: 'Pattern has no owners. GitHub treats this as a no-owner override of any prior rule.',
        hint: 'If this is intentional, add a trailing comment explaining the override. Otherwise add at least one @owner.',
      });
    }
    // Invalid owner tokens.
    for (const o of r.owners) {
      const kind = classifyOwner(o.value);
      if (kind === 'invalid') {
        findings.push({
          category: 'invalid-owner', severity: 'error',
          line: r.line, column: o.column, length: o.value.length,
          message: `Owner "${o.value}" is not a valid GitHub handle, team slug, or email.`,
          hint: 'Use @username, @org/team, or a verified email address.',
        });
      }
    }
  }

  // 2. Cross-rule checks.
  const dupes = findDuplicatePatterns(rules);
  for (const d of dupes) {
    const rule = rules.find(r => r.line === d.line);
    if (!rule) continue;
    findings.push({
      category: 'duplicate-pattern', severity: 'warning',
      line: rule.line, column: rule.patternColumn, length: rule.pattern.length,
      message: `Pattern "${rule.pattern}" is overridden by the rule on line ${d.supersededBy + 1}. This earlier rule has no effect.`,
      hint: 'Remove this rule, or merge its owners into the later rule.',
    });
  }
  const shadowed = findShadowedRules(rules);
  for (const s of shadowed) {
    const rule = rules.find(r => r.line === s.line);
    if (!rule) continue;
    // Skip if already reported as a duplicate.
    if (dupes.some(d => d.line === s.line)) continue;
    findings.push({
      category: 'unreachable-rule', severity: 'warning',
      line: rule.line, column: rule.patternColumn, length: rule.pattern.length,
      message: `Pattern "${rule.pattern}" is fully shadowed by the rule on line ${s.shadowedBy + 1}. This rule may have no effect.`,
      hint: 'Reorder so this more-specific rule comes AFTER the broader one.',
    });
  }
  const dead = findDeadPatterns(rules, files);
  for (const ln of dead) {
    const rule = rules.find(r => r.line === ln);
    if (!rule) continue;
    findings.push({
      category: 'dead-pattern', severity: 'info',
      line: rule.line, column: rule.patternColumn, length: rule.pattern.length,
      message: `Pattern "${rule.pattern}" does not match any tracked file in the repository.`,
      hint: 'Either remove the rule, or fix the pattern if you meant a different path.',
    });
  }

  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Convenience: count findings by severity for a summary header.
 */
export function summariseFindings(findings: LintFinding[]): { errors: number; warnings: number; info: number } {
  let errors = 0, warnings = 0, info = 0;
  for (const f of findings) {
    if (f.severity === 'error') errors++;
    else if (f.severity === 'warning') warnings++;
    else info++;
  }
  return { errors, warnings, info };
}
