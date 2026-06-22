/**
 * Pure helpers for the GitHub Secret Audit pill (F89).
 *
 * Scans every workflow file under `.github/workflows/*.{yml,yaml}` for
 * `${{ secrets.NAME }}` and `${{ secrets[X] }}` references, then
 * compares the unique set against the configured secrets on the
 * GitHub side (fed in from `gh secret list` + `gh variable list`).
 * Any reference that doesn't have a backing secret OR built-in
 * (GITHUB_TOKEN, ACTIONS_*) is reported as `missing` so the user can
 * either set the secret or remove the dead reference.
 *
 * Three reference shapes we recognise inside `${{ }}` expressions:
 *
 *   secrets.MY_NAME
 *   secrets['MY_NAME']
 *   secrets["MY_NAME"]
 *
 * Inline `${{ secrets[matrix.x] }}` etc. (dynamic) are NOT scanned —
 * we can't statically resolve the key, so we'd false-positive on a
 * legitimate runtime indirection. We surface a count of dynamic refs
 * separately so the user knows they exist.
 *
 * Built-in secret names that are ALWAYS available and should never
 * be flagged:
 *
 *   GITHUB_TOKEN
 *
 * The GITHUB_TOKEN secret is auto-provided to every workflow by
 * GitHub; flagging it would be hostile noise.
 *
 * Pure — no vscode, no child_process, no fs. Tests in
 * test/git/secretAudit.test.ts.
 */

export interface SecretRef {
  /** Secret name as referenced in the workflow source. */
  name: string;
  /** Workflow file (basename only — the view layer maps back to absolute path). */
  workflow: string;
  /** 1-based line number where the reference appears (best-effort). */
  line: number;
}

export interface SecretAuditResult {
  /** Distinct secret names referenced across all workflows. */
  referenced: string[];
  /** Per-reference detail (one entry per occurrence). */
  refs: SecretRef[];
  /** References whose name isn't in the configured set and isn't built-in. */
  missing: string[];
  /**
   * Number of dynamic `secrets[expr]` references whose key we couldn't
   * statically resolve. Surface this in the pill tooltip so the user
   * doesn't think the audit is 100% complete.
   */
  dynamicRefCount: number;
}

const BUILT_INS = new Set<string>([
  'GITHUB_TOKEN',
]);

const STATIC_REF_RE = /secrets\.([A-Za-z_][A-Za-z0-9_]*)/g;
const QUOTED_REF_RE = /secrets\[\s*['"]([^'"]+)['"]\s*\]/g;
const DYNAMIC_REF_RE = /secrets\[(?!\s*['"])[^\]]*\]/g;

/**
 * Scan a single workflow file body for secret references.
 *
 * Two passes:
 *   - capture `secrets.NAME` (dot access) AND `secrets['NAME']`/`secrets["NAME"]`
 *   - count `secrets[<dynamic-expr>]` separately as `dynamicRefCount`
 *
 * The line numbers we report are the line containing the FIRST `secrets`
 * token in that occurrence — close enough for "open the workflow at this
 * line" UX without a YAML parser.
 */
export function scanWorkflowBody(workflowName: string, body: string): { refs: SecretRef[]; dynamicRefCount: number } {
  if (!body) return { refs: [], dynamicRefCount: 0 };
  const refs: SecretRef[] = [];
  const lines = body.split('\n');

  // Index character offset -> line number so we can map regex match
  // positions back to a 1-based line cheaply.
  const lineOffsets: number[] = [0];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\n') lineOffsets.push(i + 1);
  }
  const lineFor = (offset: number): number => {
    // Binary search.
    let lo = 0;
    let hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineOffsets[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1; // 1-based
  };

  // Static dot-access.
  STATIC_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STATIC_REF_RE.exec(body)) !== null) {
    refs.push({ name: m[1], workflow: workflowName, line: lineFor(m.index) });
  }
  // Quoted bracket access.
  QUOTED_REF_RE.lastIndex = 0;
  while ((m = QUOTED_REF_RE.exec(body)) !== null) {
    refs.push({ name: m[1], workflow: workflowName, line: lineFor(m.index) });
  }
  // Dynamic bracket access — count only, no name extraction.
  DYNAMIC_REF_RE.lastIndex = 0;
  let dynamic = 0;
  while ((m = DYNAMIC_REF_RE.exec(body)) !== null) dynamic++;

  void lines; // line count not used directly; kept for clarity
  return { refs, dynamicRefCount: dynamic };
}

/**
 * Aggregate per-file scan results into a single audit, comparing the
 * referenced set against the configured GitHub-side secret names.
 *
 * `configured` should be the lower-case-comparable set returned by
 * the gh CLI (`gh secret list --json name | jq '.[].name'`). The
 * comparison is case-sensitive — GitHub secrets are case-sensitive
 * by name. The `built-ins` set covers GITHUB_TOKEN which never
 * appears in `gh secret list`.
 */
export interface BuildAuditArgs {
  scans: Array<{ workflow: string; refs: SecretRef[]; dynamicRefCount: number }>;
  configured: Set<string>;
}

export function buildAudit(args: BuildAuditArgs): SecretAuditResult {
  const allRefs: SecretRef[] = [];
  let dynamic = 0;
  for (const s of args.scans) {
    for (const r of s.refs) allRefs.push(r);
    dynamic += s.dynamicRefCount;
  }
  const referenced = unique(allRefs.map(r => r.name));
  const missing: string[] = [];
  for (const name of referenced) {
    if (BUILT_INS.has(name)) continue;
    if (args.configured.has(name)) continue;
    missing.push(name);
  }
  missing.sort();
  return {
    referenced: [...referenced].sort(),
    refs: allRefs,
    missing,
    dynamicRefCount: dynamic,
  };
}

function unique(items: string[]): string[] {
  const out = new Set<string>();
  for (const i of items) if (i) out.add(i);
  return [...out];
}

/**
 * Pill label for the status bar.
 *
 *   "3 missing secrets"      (red — at least one missing)
 *   "12 secrets ok"          (only shown when hideOnHealthy=false)
 *
 * The view layer decides between these and the icon prefix; this
 * helper only produces the text.
 */
export function pillLabel(audit: SecretAuditResult): string {
  if (audit.missing.length) {
    const n = audit.missing.length;
    return `${n} missing secret${n === 1 ? '' : 's'}`;
  }
  const n = audit.referenced.length;
  return `${n} secret${n === 1 ? '' : 's'} ok`;
}

/**
 * Markdown tooltip for the status-bar pill.
 *
 * Shows:
 *   - missing secrets (red bullet list) with workflow occurrence counts
 *   - referenced + ok summary
 *   - dynamic-ref count (so user knows the audit isn't exhaustive)
 *
 * Built-in escape on `<`/`>`/backtick so a hostile workflow filename
 * can't break the tooltip rendering.
 */
export function pillTooltip(audit: SecretAuditResult): string {
  const lines: string[] = [];
  lines.push('**GitSight: secret audit**');
  lines.push('');
  if (audit.missing.length) {
    lines.push(`**Missing on GitHub** (${audit.missing.length})`);
    for (const name of audit.missing) {
      const occurrences = audit.refs.filter(r => r.name === name);
      const where = summariseOccurrences(occurrences);
      lines.push(`- \`${escape(name)}\` \u00b7 ${where}`);
    }
    lines.push('');
  }
  const okCount = audit.referenced.length - audit.missing.length;
  lines.push(`${audit.referenced.length} referenced, ${okCount} configured.`);
  if (audit.dynamicRefCount > 0) {
    lines.push('');
    lines.push(`_${audit.dynamicRefCount} dynamic reference${audit.dynamicRefCount === 1 ? '' : 's'} not statically resolved._`);
  }
  return lines.join('\n');
}

function summariseOccurrences(refs: SecretRef[]): string {
  if (!refs.length) return '';
  // Group by workflow file, show count per file.
  const byFile = new Map<string, number>();
  for (const r of refs) byFile.set(r.workflow, (byFile.get(r.workflow) ?? 0) + 1);
  const parts: string[] = [];
  for (const [file, count] of byFile) {
    parts.push(`\`${escape(file)}\`${count > 1 ? ` (\u00d7${count})` : ''}`);
  }
  return parts.join(', ');
}

function escape(s: string): string {
  return s.replace(/[`<>]/g, c => c === '`' ? '\\`' : c === '<' ? '&lt;' : '&gt;');
}

/**
 * Filter the workflow directory listing to YAML files only.
 * Mirrors hasGithubWorkflows in ghActions.ts but returns the list
 * rather than a boolean so we can iterate.
 */
export function workflowFilesFromDir(entries: string[]): string[] {
  return entries.filter(n => /\.ya?ml$/i.test(n)).sort();
}
