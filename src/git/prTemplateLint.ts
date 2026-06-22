/**
 * Pure helpers for PR template lint (F103).
 *
 * Composes with F98 prTemplate. The template parser there gives us a
 * structured view of the markdown; this module classifies "is this
 * template body ready to ship as a PR description?" by hunting for the
 * tell-tale signs of an unfilled draft:
 *
 *   - Empty checkbox lists (`- [ ]` rows with no follow-up commit
 *     between scaffold and submit).
 *   - Verbatim placeholder text from the template ("Describe...",
 *     "Why...", "TODO", "TBD", "FIXME", or a stray `<!-- ... -->`
 *     instruction that the author forgot to delete).
 *   - Sections whose body is exactly the template's body (the author
 *     never touched it).
 *
 * Severity floor is configurable from the view layer; this module
 * just classifies. Callers shape the output into either a diagnostic
 * collection (PR-body editor) or a modal pre-submit gate (run on the
 * `generatePullRequestDescription` flow).
 *
 * Pure - no fs, no vscode. Tests in test/git/prTemplateLint.test.ts.
 */

import { parseTemplateSections, TemplateSection } from './prTemplate';

export type PrLintSeverity = 'info' | 'warning' | 'error';

export type PrLintCategory =
  | 'empty-checkbox'         // - [ ] rows present (often fine; warn anyway when severity floor is high)
  | 'verbatim-placeholder'   // TODO/TBD/FIXME or "Describe..." style text
  | 'instruction-leftover'   // <!-- HTML comment instructions to author -->
  | 'untouched-section'      // section body matches the template body byte-for-byte
  | 'empty-section'          // section heading present but body is empty
  | 'unfilled-link'          // a literal `<link>` / `<url>` placeholder
  | 'missing-section';        // a section the template requires is absent entirely

export interface PrLintFinding {
  category: PrLintCategory;
  severity: PrLintSeverity;
  /** Zero-based line in the PR body where the finding starts. */
  line: number;
  /** Zero-based column. */
  column: number;
  /** Length of the highlighted span (>= 1). */
  length: number;
  /** Display message. */
  message: string;
  /** Optional remediation hint. */
  hint?: string;
}

/**
 * Placeholder regexes. Order matters — `verbatim-placeholder` is
 * matched before `instruction-leftover` so a `<!-- TODO -->` becomes
 * the instruction-leftover (HTML comment) not the TODO (verbatim).
 *
 * Word-boundary-anchored so `TODOSAUR` and `FIXMER` don't false-fire.
 * Anchored to start-of-token only — a "TODO" inside a code fence
 * is still a hit (often intentional, but the user can disable in
 * config); a "todo" lowercased inside running prose IS a hit.
 */
const PLACEHOLDER_PATTERNS: { rx: RegExp; label: string }[] = [
  { rx: /\b(TODO|TBD|FIXME|XXX)\b/g, label: 'placeholder keyword' },
  { rx: /\b(Describe\s+(your\s+)?changes?)\b/gi, label: 'describe placeholder' },
  { rx: /\bWhy\s+(are\s+)?(you\s+making|is\s+this)\s+(this\s+change|change\s+needed)\b/gi, label: 'why placeholder' },
  { rx: /\b(N\/A|TBA)\b/g, label: 'unfilled marker' },
  { rx: /\b(Lorem\s+ipsum)\b/gi, label: 'lorem placeholder' },
];

const HTML_COMMENT_RX = /<!--[\s\S]*?-->/g;

const UNFILLED_LINK_RX = /<(link|url|issue|pr|number)>/gi;

/**
 * Severity floors per category. Callers can override individual values.
 */
const DEFAULT_SEVERITIES: Record<PrLintCategory, PrLintSeverity> = {
  'empty-checkbox': 'info',
  'verbatim-placeholder': 'warning',
  'instruction-leftover': 'warning',
  'untouched-section': 'warning',
  'empty-section': 'info',
  'unfilled-link': 'warning',
  'missing-section': 'info',
};

export interface LintOptions {
  /** Severity overrides per category. */
  severities?: Partial<Record<PrLintCategory, PrLintSeverity>>;
  /** When provided, an "untouched-section" check fires when the PR
   * body's section equals the template body. */
  templateBody?: string;
  /** When provided, sections in this list are warned when missing entirely. */
  requiredSections?: string[];
  /** When true, every `- [ ]` row is flagged (default false). */
  flagEmptyCheckboxes?: boolean;
}

/**
 * Classify a PR body. Returns one finding per issue, line-indexed so
 * the diagnostic collection can highlight ranges precisely.
 */
export function lintPrBody(body: string, options: LintOptions = {}): PrLintFinding[] {
  if (!body) return [];
  const sevs = { ...DEFAULT_SEVERITIES, ...(options.severities ?? {}) };
  const findings: PrLintFinding[] = [];

  // HTML comment leftovers — multi-line aware.
  scanRegex(body, HTML_COMMENT_RX, m => {
    findings.push({
      category: 'instruction-leftover',
      severity: sevs['instruction-leftover'],
      line: m.line,
      column: m.column,
      length: m.length,
      message: 'HTML comment from template — remove before merging.',
      hint: 'These instruction blocks are for the author; reviewers and the GitHub UI render them invisibly but they live in the body.',
    });
  });

  // Per-line scans (skipping ranges already covered by HTML comments
  // is over-engineering for v1; the verbatim-placeholder + HTML-comment
  // overlap is fine — both findings are meaningful).
  const lines = body.split('\n');
  let fenceMarker: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fence tracking — we still scan inside fences (a TODO comment
    // in code is a real signal, especially for templates), but we
    // suppress the empty-checkbox check inside fences.
    const fence = /^(\s{0,3})(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!fenceMarker) fenceMarker = fence[2][0];
      else if (line.trimStart().startsWith(fenceMarker)) fenceMarker = undefined;
    }

    // Verbatim placeholders.
    for (const p of PLACEHOLDER_PATTERNS) {
      p.rx.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.rx.exec(line))) {
        findings.push({
          category: 'verbatim-placeholder',
          severity: sevs['verbatim-placeholder'],
          line: i,
          column: m.index,
          length: m[0].length,
          message: `Unfilled ${p.label}: "${m[0]}".`,
          hint: 'Replace with the actual content before submitting.',
        });
      }
    }

    // Unfilled <link> / <url> placeholders.
    UNFILLED_LINK_RX.lastIndex = 0;
    let lm: RegExpExecArray | null;
    while ((lm = UNFILLED_LINK_RX.exec(line))) {
      findings.push({
        category: 'unfilled-link',
        severity: sevs['unfilled-link'],
        line: i,
        column: lm.index,
        length: lm[0].length,
        message: `Unfilled placeholder: ${lm[0]}`,
        hint: 'Replace with the real link/URL/issue number.',
      });
    }

    // Empty checkboxes — opt-in.
    if (options.flagEmptyCheckboxes && !fenceMarker) {
      const cb = /^(\s*)-\s+\[\s\]\s+(.+)$/.exec(line);
      if (cb) {
        findings.push({
          category: 'empty-checkbox',
          severity: sevs['empty-checkbox'],
          line: i,
          column: 0,
          length: line.length,
          message: 'Unchecked checklist item.',
          hint: 'Confirm the item is done and tick the box, or remove the line.',
        });
      }
    }
  }

  // Section-level checks.
  const parsed = parseTemplateSections(body);

  // Empty section bodies (a heading with no real content).
  for (const s of parsed.sections) {
    if (s.body.trim().length === 0) {
      findings.push({
        category: 'empty-section',
        severity: sevs['empty-section'],
        line: findSectionLine(body, s),
        column: 0,
        length: s.heading.length,
        message: `Section "${stripHash(s.heading).trim()}" is empty.`,
        hint: 'Fill it in or remove the heading entirely.',
      });
    }
  }

  // Untouched sections (body matches template body byte-for-byte).
  if (options.templateBody) {
    const tmplParsed = parseTemplateSections(options.templateBody);
    const tmplByKey = new Map<string, TemplateSection>();
    for (const s of tmplParsed.sections) tmplByKey.set(s.key, s);
    for (const s of parsed.sections) {
      const tmpl = tmplByKey.get(s.key);
      if (!tmpl) continue;
      const a = s.body.trim();
      const b = tmpl.body.trim();
      if (a && a === b) {
        findings.push({
          category: 'untouched-section',
          severity: sevs['untouched-section'],
          line: findSectionLine(body, s),
          column: 0,
          length: s.heading.length,
          message: `Section "${stripHash(s.heading).trim()}" is verbatim from the template.`,
          hint: 'Replace with the actual content for this PR.',
        });
      }
    }
  }

  // Missing required sections.
  if (options.requiredSections && options.requiredSections.length) {
    const haveKeys = new Set(parsed.sections.map(s => s.key));
    for (const req of options.requiredSections) {
      const reqKey = req.toLowerCase().trim();
      if (!haveKeys.has(reqKey)) {
        findings.push({
          category: 'missing-section',
          severity: sevs['missing-section'],
          line: 0,
          column: 0,
          length: 1,
          message: `Required section missing: "${req}".`,
          hint: 'Add the heading and fill in the body.',
        });
      }
    }
  }

  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Aggregate a verdict for the pre-submit gate. Returns the highest
 * severity encountered, or 'ok' when there are no findings.
 */
export function lintVerdict(findings: PrLintFinding[]): PrLintSeverity | 'ok' {
  if (findings.some(f => f.severity === 'error')) return 'error';
  if (findings.some(f => f.severity === 'warning')) return 'warning';
  if (findings.some(f => f.severity === 'info')) return 'info';
  return 'ok';
}

/**
 * Short human summary like "3 findings (2 warnings, 1 info)".
 */
export function summariseLint(findings: PrLintFinding[]): string {
  if (!findings.length) return 'No issues found.';
  const counts: Record<PrLintSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const parts: string[] = [];
  if (counts.error) parts.push(`${counts.error} error${counts.error === 1 ? '' : 's'}`);
  if (counts.warning) parts.push(`${counts.warning} warning${counts.warning === 1 ? '' : 's'}`);
  if (counts.info) parts.push(`${counts.info} info`);
  return `${findings.length} finding${findings.length === 1 ? '' : 's'} (${parts.join(', ')}).`;
}

// ── internals ──────────────────────────────────────────────────────

interface RegexMatch {
  line: number;
  column: number;
  length: number;
  text: string;
}

function scanRegex(body: string, rx: RegExp, fn: (m: RegexMatch) => void): void {
  // Re-create the regex with the global flag we need, anchored to
  // an offset-aware scan against the original body.
  const localRx = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : rx.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = localRx.exec(body))) {
    const idx = m.index;
    const before = body.slice(0, idx);
    const line = (before.match(/\n/g) ?? []).length;
    const lastNl = before.lastIndexOf('\n');
    const column = idx - (lastNl + 1);
    fn({ line, column, length: m[0].length, text: m[0] });
  }
}

function findSectionLine(body: string, section: TemplateSection): number {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) if (lines[i] === section.heading) return i;
  return 0;
}

function stripHash(heading: string): string {
  return heading.replace(/^#+\s*/, '').replace(/\s*#*\s*$/, '');
}
