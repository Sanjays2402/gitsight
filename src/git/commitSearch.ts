/**
 * Pure helpers for the Advanced Commit Search (F51).
 *
 * The current `gitsight.searchCommits` command takes a single subject
 * substring and feeds it to a tree view. This module powers a richer
 * picker that supports:
 *
 *   - subject/body regex   (default — `--grep` with optional `--regexp-ignore-case`)
 *   - author filter        (`--author=` glob)
 *   - path/glob filter     (`-- <pathspec>` after `--`)
 *   - date range filter    (`--since=` / `--until=` in ISO or relative form)
 *   - max-count guard      (default 200, hard cap 5000)
 *
 * The query syntax is parsed from a flat string so the user can type
 * everything in one input box; tokens are space-separated key:value
 * pairs with quoting support, and bare tokens become subject regex
 * fragments. Examples:
 *
 *   parser bug                     → grep "parser bug"
 *   author:alice path:src/         → --author=alice -- src/
 *   "fix: typo" since:2026-01-01   → grep "fix: typo" --since=2026-01-01
 *   re:^WIP                        → grep --extended-regexp "^WIP"
 *
 * Output of buildSearchArgs is a list of git-log args ready to splice
 * after `log` and before the result-format flags.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/commitSearch.test.ts.
 */

export interface SearchQuery {
  /** Subject/body substrings or regex fragments to OR together via repeated --grep. */
  grep: string[];
  /** True when grep terms should be treated as extended-regex (`re:` prefix). */
  regex: boolean;
  /** Match case insensitively (default true). */
  ignoreCase: boolean;
  /** Author filters (substring; git accepts a glob-ish pattern). */
  authors: string[];
  /** Path/glob pathspecs (passed after `--`). */
  paths: string[];
  /** `--since=` (relative or ISO). */
  since?: string;
  /** `--until=` (relative or ISO). */
  until?: string;
  /** `--max-count=`. */
  maxCount: number;
  /** Original query text, for echo back. */
  raw: string;
}

const DEFAULT_MAX = 200;
const HARD_MAX = 5000;

/**
 * Tokenise a query string, respecting double-quoted spans.
 */
export function tokenise(input: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (buf) { out.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Parse a query string into a SearchQuery.
 *
 * Recognised key prefixes (colon-separated):
 *   author:<name>         → adds an author filter (multi-allowed).
 *   path:<glob>           → adds a path filter (multi-allowed).
 *   since:<spec>          → --since.
 *   until:<spec>          → --until.
 *   case:on|off           → toggles ignoreCase. Default on.
 *   max:<N>               → cap on results (clamped to 1..HARD_MAX).
 *   re:<fragment>         → adds a regex grep term and enables extended-regex.
 *
 * Bare tokens (no `:`) become grep terms.
 */
export function parseQuery(input: string, defaults: { maxCount?: number } = {}): SearchQuery {
  const tokens = tokenise(input ?? '');
  const q: SearchQuery = {
    grep: [],
    regex: false,
    ignoreCase: true,
    authors: [],
    paths: [],
    maxCount: clamp(defaults.maxCount ?? DEFAULT_MAX, 1, HARD_MAX),
    raw: input ?? '',
  };
  for (const t of tokens) {
    const m = /^([a-zA-Z]+):(.*)$/.exec(t);
    if (!m) {
      if (t) q.grep.push(t);
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2];
    switch (key) {
      case 'author':
        if (value) q.authors.push(value);
        break;
      case 'path':
        if (value) q.paths.push(value);
        break;
      case 'since':
        if (value) q.since = value;
        break;
      case 'until':
      case 'before':
        if (value) q.until = value;
        break;
      case 'case':
        if (value === 'off' || value === 'sensitive' || value === '0') q.ignoreCase = false;
        else q.ignoreCase = true;
        break;
      case 'max':
      case 'limit': {
        const n = parseInt(value, 10);
        if (Number.isFinite(n)) q.maxCount = clamp(n, 1, HARD_MAX);
        break;
      }
      case 're':
      case 'regex':
        q.regex = true;
        if (value) q.grep.push(value);
        break;
      default:
        // Unknown prefix → treat the whole token as a literal grep fragment.
        if (t) q.grep.push(t);
    }
  }
  return q;
}

/**
 * Build the argv passed to `git log`. The returned array does NOT include
 * the leading `log` itself or any format flags — the controller adds
 * those (so we can swap formats for picker vs. tree without re-parsing).
 */
export function buildSearchArgs(q: SearchQuery): string[] {
  const args: string[] = [];
  for (const g of q.grep) args.push(`--grep=${g}`);
  if (q.grep.length > 0 && q.ignoreCase) args.push('--regexp-ignore-case');
  if (q.regex) args.push('--extended-regexp');
  if (q.grep.length > 1) args.push('--all-match=no'); // OR mode is default; explicit for clarity
  for (const a of q.authors) args.push(`--author=${a}`);
  if (q.since) args.push(`--since=${q.since}`);
  if (q.until) args.push(`--until=${q.until}`);
  args.push(`--max-count=${q.maxCount}`);
  if (q.paths.length) {
    args.push('--');
    args.push(...q.paths);
  }
  return args;
}

export interface ParsedHit {
  sha: string;
  shortSha: string;
  dateIso: string;
  author: string;
  subject: string;
}

/**
 * Parse `git log --pretty=format:'%H|%h|%aI|%an|%s'` output.
 * Subject can contain '|' so everything after the fourth separator
 * is joined back together.
 */
export function parseHits(raw: string): ParsedHit[] {
  const out: ParsedHit[] = [];
  for (const line of (raw ?? '').split('\n')) {
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const [sha, shortSha, dateIso, author, ...rest] = parts;
    out.push({ sha, shortSha, dateIso, author, subject: rest.join('|') });
  }
  return out;
}

/**
 * Render a one-line "[N hits · M authors · range Y]" summary used in the
 * picker header.
 */
export function describeHits(hits: ParsedHit[]): string {
  if (!hits.length) return 'No matches';
  const authors = new Set(hits.map(h => h.author.toLowerCase())).size;
  // Date range
  const dates = hits.map(h => h.dateIso).filter(Boolean).sort();
  const first = dates[0]?.slice(0, 10) ?? '';
  const last = dates[dates.length - 1]?.slice(0, 10) ?? '';
  const range = first && last ? (first === last ? first : `${first} → ${last}`) : '';
  return `${hits.length} match${hits.length === 1 ? '' : 'es'} · ${authors} author${authors === 1 ? '' : 's'}${range ? ' · ' + range : ''}`;
}

/**
 * Human description of the query — used in the no-match toast.
 */
export function describeQuery(q: SearchQuery): string {
  const bits: string[] = [];
  if (q.grep.length) bits.push(`grep: ${q.grep.map(g => `"${g}"`).join(', ')}`);
  if (q.authors.length) bits.push(`author: ${q.authors.join(', ')}`);
  if (q.paths.length) bits.push(`path: ${q.paths.join(', ')}`);
  if (q.since) bits.push(`since ${q.since}`);
  if (q.until) bits.push(`until ${q.until}`);
  if (q.regex) bits.push('regex');
  if (!q.ignoreCase) bits.push('case-sensitive');
  bits.push(`max ${q.maxCount}`);
  return bits.join(', ') || '(empty query)';
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
