/**
 * Pure helpers for the Cherry-Pick Scout (F65).
 *
 * Before cherry-picking a commit onto the current branch, scan the recent
 * history for a same-subject-shape commit that's already been picked.
 * git creates a "cherry picked from commit <sha>" trailer when you pass
 * `-x`, but most workflows DON'T use -x, so the only reliable signal
 * across teams is subject collision.
 *
 * Strategy:
 *   1. Normalise the source commit's subject (strip Conventional-Commit
 *      headers, trim trailing periods, collapse whitespace, drop
 *      `(#123)` PR-number suffixes that get added on merge).
 *   2. Look for any recent commit on the current branch with the same
 *      normalised subject (or with a "cherry picked from commit" trailer
 *      pointing at the source sha when -x was used).
 *   3. Score matches: exact-trailer > exact-subject > normalised-match.
 *
 * Returns a verdict the controller turns into a modal warning.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/cherryPickScout.test.ts.
 */

export type ScoutMatchKind = 'trailer-exact' | 'subject-exact' | 'subject-normalised';

export interface ScoutMatch {
  /** Commit on the current branch that matched. */
  sha: string;
  shortSha: string;
  /** Raw subject as found in the candidate commit. */
  subject: string;
  /** Author name (for context in the modal). */
  author?: string;
  /** ISO 8601 timestamp. */
  dateIso?: string;
  /** How strong the match is. */
  kind: ScoutMatchKind;
}

export interface ScoutVerdict {
  /** True when at least one candidate is found. */
  alreadyPicked: boolean;
  matches: ScoutMatch[];
  /** Normalised version of the source subject used for matching. */
  normalisedSubject: string;
}

/**
 * Normalise a commit subject for cross-branch matching. Strips:
 *   - Leading Conventional-Commit headers: `feat(scope): `, `fix: `, `feat!:`
 *   - Trailing GitHub-merge PR number: ` (#1234)`
 *   - Trailing periods and surrounding whitespace
 *   - Backports / branch suffixes: `[backport 1.x]`, `[release/2.0]`
 *   - Multiple whitespace runs collapsed to single space
 *   - Case-folded
 */
export function normaliseSubject(subject: string): string {
  if (!subject) return '';
  let s = subject.trim();
  // Strip a leading "[scope] " or "[backport 1.x]" tag once.
  s = s.replace(/^\[[^\]]+\]\s+/, '');
  // Strip Conventional-Commit header once: type(scope)!: rest
  s = s.replace(/^[a-z]+(?:\([^)]+\))?!?:\s+/i, '');
  // Strip trailing "(#1234)" PR suffix.
  s = s.replace(/\s*\(#\d+\)\s*$/, '');
  // Strip trailing periods.
  s = s.replace(/\.+$/, '');
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  return s.toLowerCase();
}

export interface RecentCommit {
  sha: string;
  shortSha: string;
  author?: string;
  dateIso?: string;
  subject: string;
  body?: string;
}

/**
 * Parse the output of:
 *
 *   git log <range> --pretty=format:'%H|%h|%an|%aI|%s%n%b%n--RECORD--'
 *
 * Each commit is one record, separated by `--RECORD--` lines. The body can
 * be multi-line so we accept everything between the header line and the
 * separator.
 */
const RECORD_SEPARATOR = '--RECORD--';

export function parseLogRecords(raw: string): RecentCommit[] {
  if (!raw) return [];
  const out: RecentCommit[] = [];
  const records = raw.split(`\n${RECORD_SEPARATOR}`);
  for (const rec of records) {
    const trimmed = rec.replace(/^\n+/, '').replace(/\n+$/, '');
    if (!trimmed) continue;
    const newlineIdx = trimmed.indexOf('\n');
    const headerLine = newlineIdx === -1 ? trimmed : trimmed.slice(0, newlineIdx);
    const body = newlineIdx === -1 ? '' : trimmed.slice(newlineIdx + 1);
    const parts = headerLine.split('|');
    if (parts.length < 5) continue;
    const [sha, shortSha, author, dateIso, ...subjectRest] = parts;
    out.push({
      sha,
      shortSha,
      author: author || undefined,
      dateIso: dateIso || undefined,
      subject: subjectRest.join('|'),
      body: body || undefined,
    });
  }
  return out;
}

/**
 * Look through `recent` for commits that already correspond to `source`.
 * The source can be a real commit (with subject + sha) or just the
 * subject (when called from a webview that only has the rendered text).
 */
export function findAlreadyPicked(
  source: { sha: string; subject: string },
  recent: RecentCommit[],
): ScoutVerdict {
  const matches: ScoutMatch[] = [];
  const normSource = normaliseSubject(source.subject);

  for (const c of recent) {
    // Exact trailer pointer wins.
    const trailerHit = c.body && new RegExp(
      `cherry picked from commit\\s+${escapeRegExp(source.sha.slice(0, 7))}`,
      'i',
    ).test(c.body);
    if (trailerHit) {
      matches.push({
        sha: c.sha,
        shortSha: c.shortSha,
        subject: c.subject,
        author: c.author,
        dateIso: c.dateIso,
        kind: 'trailer-exact',
      });
      continue;
    }
    // Exact-subject match next — but bail when the source subject is empty
    // (matching every empty-subject commit is a useless false positive).
    if (source.subject && c.subject === source.subject) {
      matches.push({
        sha: c.sha,
        shortSha: c.shortSha,
        subject: c.subject,
        author: c.author,
        dateIso: c.dateIso,
        kind: 'subject-exact',
      });
      continue;
    }
    // Normalised subject match last.
    if (normSource && normSource === normaliseSubject(c.subject)) {
      matches.push({
        sha: c.sha,
        shortSha: c.shortSha,
        subject: c.subject,
        author: c.author,
        dateIso: c.dateIso,
        kind: 'subject-normalised',
      });
    }
  }

  // Strongest match first.
  const kindRank: Record<ScoutMatchKind, number> = {
    'trailer-exact':       0,
    'subject-exact':       1,
    'subject-normalised':  2,
  };
  matches.sort((a, b) => {
    const r = kindRank[a.kind] - kindRank[b.kind];
    if (r !== 0) return r;
    return (b.dateIso ?? '').localeCompare(a.dateIso ?? '');
  });

  return {
    alreadyPicked: matches.length > 0,
    matches,
    normalisedSubject: normSource,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Render a one-line description for the warning modal. */
export function describeMatch(m: ScoutMatch): string {
  const kindLabel: Record<ScoutMatchKind, string> = {
    'trailer-exact':      'cherry-picked-from trailer',
    'subject-exact':      'exact subject match',
    'subject-normalised': 'normalised subject match',
  };
  const bits = [`${m.shortSha} ${m.subject}`];
  bits.push(`(${kindLabel[m.kind]})`);
  if (m.author) bits.push(`by ${m.author}`);
  if (m.dateIso) bits.push(`on ${m.dateIso.slice(0, 10)}`);
  return bits.join(' \u00b7 ');
}

/** Build the warning header for the modal — concise, action-oriented. */
export function warningHeadline(source: { shortSha: string; subject: string }, verdict: ScoutVerdict): string {
  const n = verdict.matches.length;
  if (n === 0) return '';
  const top = verdict.matches[0];
  return `${source.shortSha} "${source.subject.slice(0, 60)}" looks like it's already on this branch (${n === 1 ? 'matched ' : `${n} matches, top: `}${top.shortSha}, ${top.kind}).`;
}
