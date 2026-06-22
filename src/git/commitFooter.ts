/**
 * Pure helpers for the Conventional Commit footer composer (F73).
 *
 * The F29 picker writes the conventional commit *header* and F60 scaffolds
 * a blank header from staged paths. This module is the third leg:
 * appending well-known trailers to the SCM input box.
 *
 * Supported trailers (the picker exposes them in this order):
 *
 *   - Co-authored-by:  Name <email>          (composes with F18 picks)
 *   - Reviewed-by:     Name <email>
 *   - Signed-off-by:   Name <email>          (DCO standard)
 *   - Closes:          #N or org/repo#N
 *   - Fixes:           #N
 *   - Refs:            #N
 *   - BREAKING CHANGE: free text
 *
 * Each trailer is validated (the email/issue-ref shapes are strict so
 * the user gets caught typing `Closes: 123` without a `#`) before we
 * insert it. Existing trailers of the same shape are de-duplicated so
 * running the picker twice doesn't double the block.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/commitFooter.test.ts.
 */

export type FooterKind =
  | 'co-authored-by'
  | 'reviewed-by'
  | 'signed-off-by'
  | 'closes'
  | 'fixes'
  | 'refs'
  | 'breaking-change';

export interface FooterDefinition {
  kind: FooterKind;
  /** Canonical trailer key written into the message (case is preserved). */
  key: string;
  /** Picker label. */
  label: string;
  /** Tooltip-style description shown in the picker. */
  description: string;
  /** Whether the trailer takes a name+email (vs a free-text value). */
  shape: 'name-email' | 'issue-ref' | 'free-text';
}

export const FOOTER_DEFINITIONS: FooterDefinition[] = [
  { kind: 'co-authored-by', key: 'Co-authored-by', label: 'Co-authored-by', description: 'Credit another person for the change', shape: 'name-email' },
  { kind: 'reviewed-by',    key: 'Reviewed-by',    label: 'Reviewed-by',    description: 'Acknowledge a reviewer', shape: 'name-email' },
  { kind: 'signed-off-by',  key: 'Signed-off-by',  label: 'Signed-off-by',  description: 'DCO sign-off (the `-s` flag equivalent)', shape: 'name-email' },
  { kind: 'closes',         key: 'Closes',         label: 'Closes',         description: 'Close an issue when merged (e.g. #123 or org/repo#123)', shape: 'issue-ref' },
  { kind: 'fixes',          key: 'Fixes',          label: 'Fixes',          description: 'Mark an issue as fixed', shape: 'issue-ref' },
  { kind: 'refs',           key: 'Refs',           label: 'Refs',           description: 'Reference an issue without closing it', shape: 'issue-ref' },
  { kind: 'breaking-change', key: 'BREAKING CHANGE', label: 'BREAKING CHANGE', description: 'Document a breaking API change', shape: 'free-text' },
];

export interface FooterEntry {
  kind: FooterKind;
  /** Verbatim value to render after the trailer key. */
  value: string;
}

const NAME_EMAIL_RE = /^[^<>\n]+<[^@\s<>]+@[^\s<>]+>$/;
const ISSUE_REF_RE = /^(?:[A-Za-z0-9._\-]+\/[A-Za-z0-9._\-]+)?#[0-9]+(?:,\s*(?:[A-Za-z0-9._\-]+\/[A-Za-z0-9._\-]+)?#[0-9]+)*$/;

/**
 * Validate a value against the footer's expected shape. Returns
 * undefined when valid; otherwise a human-friendly error suitable for
 * a `validateInput` callback.
 */
export function validateFooterValue(kind: FooterKind, value: string): string | undefined {
  const v = value.trim();
  if (!v) return 'Value required';
  const def = FOOTER_DEFINITIONS.find(d => d.kind === kind);
  if (!def) return 'Unknown footer kind';
  switch (def.shape) {
    case 'name-email':
      return NAME_EMAIL_RE.test(v) ? undefined : 'Expected: Name <email@example.com>';
    case 'issue-ref':
      return ISSUE_REF_RE.test(v) ? undefined : 'Expected: #123 or org/repo#123 (comma-separated for multiple)';
    case 'free-text':
      return v.length > 0 ? undefined : 'Value required';
    default:
      return undefined;
  }
}

/**
 * Render one footer entry to its canonical line form.
 *
 *   { kind: 'closes', value: '#42' }
 *   → 'Closes: #42'
 *
 *   { kind: 'co-authored-by', value: 'Alice <a@example.com>' }
 *   → 'Co-authored-by: Alice <a@example.com>'
 */
export function renderFooterLine(entry: FooterEntry): string {
  const def = FOOTER_DEFINITIONS.find(d => d.kind === entry.kind);
  if (!def) return '';
  return `${def.key}: ${entry.value.trim()}`;
}

/**
 * Walk the current message and find existing trailers of the same
 * shape, returning their values. Used to de-duplicate the next insert.
 */
export function extractExistingFooters(message: string): FooterEntry[] {
  if (!message) return [];
  const out: FooterEntry[] = [];
  for (const raw of message.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    for (const def of FOOTER_DEFINITIONS) {
      const prefix = `${def.key}:`;
      // Match case-insensitively but preserve the value.
      if (line.toLowerCase().startsWith(prefix.toLowerCase())) {
        const value = line.slice(prefix.length).trim();
        if (value) out.push({ kind: def.kind, value });
        break;
      }
    }
  }
  return out;
}

/**
 * Append footer entries to a commit message, preserving any non-trailer
 * body the user already typed and folding duplicates. The function
 * guarantees a blank line between the body and the first trailer (a
 * git convention enforced by `git interpret-trailers`).
 *
 * Duplicate filter is case-insensitive on values for name-email and
 * issue-ref shapes; free-text trailers (BREAKING CHANGE) are matched
 * case-sensitively on the full string.
 */
export function appendFooters(message: string, entries: FooterEntry[]): string {
  if (!entries.length) return message;
  const existing = extractExistingFooters(message);
  const existingKeys = new Set(existing.map(footerKey));
  const fresh = entries.filter(e => !existingKeys.has(footerKey(e)));
  if (!fresh.length) return message;
  const lines = fresh.map(renderFooterLine);
  const trimmed = (message ?? '').replace(/[\s\n]+$/, '');
  if (!trimmed) return lines.join('\n') + '\n';
  // If the message already has a trailer block at the bottom, append
  // immediately after it (no extra blank line). Otherwise insert with
  // a blank-line separator.
  if (endsWithTrailer(trimmed)) {
    return `${trimmed}\n${lines.join('\n')}\n`;
  }
  return `${trimmed}\n\n${lines.join('\n')}\n`;
}

function endsWithTrailer(message: string): boolean {
  const lastLine = message.split('\n').filter(Boolean).pop() ?? '';
  for (const def of FOOTER_DEFINITIONS) {
    if (lastLine.toLowerCase().startsWith(`${def.key.toLowerCase()}:`)) return true;
  }
  return false;
}

function footerKey(entry: FooterEntry): string {
  // Free-text trailers compare case-sensitively so two different
  // BREAKING CHANGE notes both land. Other trailers normalise.
  const def = FOOTER_DEFINITIONS.find(d => d.kind === entry.kind);
  if (def?.shape === 'free-text') return `${entry.kind}|${entry.value.trim()}`;
  return `${entry.kind}|${entry.value.trim().toLowerCase()}`;
}

/**
 * Normalise an issue ref value: strip spaces, ensure `#` prefix on each
 * piece, comma-join cleanly. Returns undefined when nothing usable.
 *
 *   ' 123 , 456 ' → '#123, #456'
 *   '#7'          → '#7'
 *   'foo/bar#1'   → 'foo/bar#1'
 */
export function normaliseIssueRef(raw: string): string | undefined {
  if (!raw) return undefined;
  const pieces = raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  if (!pieces.length) return undefined;
  const normalised = pieces.map(p => p.includes('#') ? p : `#${p}`);
  // Validate each piece.
  for (const p of normalised) {
    if (!/^([A-Za-z0-9._\-]+\/[A-Za-z0-9._\-]+)?#[0-9]+$/.test(p)) return undefined;
  }
  return normalised.join(', ');
}
