/**
 * GitSight shared commit-query parser + matcher (W10).
 *
 * STACK-AGNOSTIC. No `vscode`, no Node, no DOM. Upgrades the web app's
 * naive substring filter into a structured query language mirroring the
 * extension's F51 commitSearch, evaluated client-side against the loaded
 * GraphSnapshot (which carries author, email, subject, sha, date, refs).
 *
 * Query grammar (whitespace-separated terms, case-insensitive):
 *   author:<text>   match author name or email substring
 *   grep:<text>     match subject substring (alias: subject:, msg:)
 *   ref:<text>      match any decoration ref substring (branch/tag/HEAD)
 *   since:<date>    commits on/after an ISO date (YYYY-MM-DD or full ISO)
 *   until:<date>    commits on/before an ISO date (alias: before:)
 *   sha:<text>      match full or short sha prefix
 *   <bare text>     match subject OR author OR sha prefix (the old behaviour)
 *
 * Quoted values are supported: author:"Ada Lovelace". Multiple terms AND
 * together. An unparseable date term is ignored (so a half-typed
 * `since:2026-` doesn't blank the graph mid-keystroke).
 *
 * No cross-file runtime import (Node type-strip compatible). Operates on
 * a minimal structural shape so it doesn't depend on graphSnapshot.
 *
 * Tests: test/git/commitQuery.test.ts
 */

/** The minimal commit shape the matcher reads. */
export interface QueryableCommit {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  subject: string;
  /** ISO-8601 date string. */
  date: string;
  refs: string[];
}

export type QueryField = 'author' | 'grep' | 'ref' | 'sha' | 'since' | 'until' | 'text';

export interface QueryTerm {
  field: QueryField;
  value: string;
  /** For since/until, the parsed epoch ms; NaN when unparseable. */
  epoch?: number;
}

export interface ParsedQuery {
  terms: QueryTerm[];
}

const FIELD_ALIASES: Record<string, QueryField> = {
  author: 'author',
  by: 'author',
  grep: 'grep',
  subject: 'grep',
  msg: 'grep',
  message: 'grep',
  ref: 'ref',
  branch: 'ref',
  tag: 'ref',
  sha: 'sha',
  commit: 'sha',
  since: 'since',
  after: 'since',
  until: 'until',
  before: 'until',
};

/**
 * Tokenise a raw query string into terms, honouring double quotes so a
 * value can contain spaces. Returns the field:value pairs + bare terms.
 */
export function tokenizeQuery(raw: string): Array<{ key: string | null; value: string }> {
  const tokens: Array<{ key: string | null; value: string }> = [];
  const re = /(\w+):"([^"]*)"|"([^"]*)"|(\w+):(\S+)|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== undefined) {
      tokens.push({ key: m[1], value: m[2] });
    } else if (m[3] !== undefined) {
      tokens.push({ key: null, value: m[3] });
    } else if (m[4] !== undefined) {
      tokens.push({ key: m[4], value: m[5] });
    } else if (m[6] !== undefined) {
      tokens.push({ key: null, value: m[6] });
    }
  }
  return tokens;
}

/**
 * Parse a date value to epoch ms. Accepts `YYYY-MM-DD` (treated as local
 * midnight) and full ISO strings. Returns NaN for anything unparseable.
 */
export function parseQueryDate(value: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const t = Date.parse(`${value}T00:00:00`);
    return t;
  }
  return Date.parse(value);
}

/** Parse a raw query string into structured terms. */
export function parseQuery(raw: string): ParsedQuery {
  const terms: QueryTerm[] = [];
  for (const tok of tokenizeQuery(raw.trim())) {
    if (tok.value === '') continue;
    if (tok.key) {
      const field = FIELD_ALIASES[tok.key.toLowerCase()];
      if (!field) {
        // Unknown key: treat the whole `key:value` as a bare text term so
        // searching for e.g. "fix:bug" still works literally.
        terms.push({ field: 'text', value: `${tok.key}:${tok.value}` });
        continue;
      }
      if (field === 'since' || field === 'until') {
        terms.push({ field, value: tok.value, epoch: parseQueryDate(tok.value) });
      } else {
        terms.push({ field, value: tok.value });
      }
    } else {
      terms.push({ field: 'text', value: tok.value });
    }
  }
  return { terms };
}

/** Does a single term match a commit? */
export function termMatches(term: QueryTerm, c: QueryableCommit): boolean {
  const v = term.value.toLowerCase();
  switch (term.field) {
    case 'author':
      return c.author.toLowerCase().includes(v) || c.email.toLowerCase().includes(v);
    case 'grep':
      return c.subject.toLowerCase().includes(v);
    case 'ref':
      return c.refs.some(r => r.toLowerCase().includes(v));
    case 'sha':
      return c.sha.toLowerCase().startsWith(v) || c.shortSha.toLowerCase().startsWith(v);
    case 'since': {
      if (term.epoch === undefined || Number.isNaN(term.epoch)) return true; // ignore bad date
      const t = Date.parse(c.date);
      return Number.isNaN(t) ? false : t >= term.epoch;
    }
    case 'until': {
      if (term.epoch === undefined || Number.isNaN(term.epoch)) return true;
      const t = Date.parse(c.date);
      return Number.isNaN(t) ? false : t <= term.epoch;
    }
    case 'text':
    default:
      return (
        c.subject.toLowerCase().includes(v) ||
        c.author.toLowerCase().includes(v) ||
        c.sha.toLowerCase().startsWith(v) ||
        c.shortSha.toLowerCase().startsWith(v)
      );
  }
}

/** Does a commit satisfy every term (AND semantics)? Empty query = all. */
export function commitMatchesQuery(c: QueryableCommit, query: ParsedQuery): boolean {
  if (query.terms.length === 0) return true;
  return query.terms.every(t => termMatches(t, c));
}

/** Convenience: parse + filter a list in one call. */
export function filterCommits<C extends QueryableCommit>(commits: C[], raw: string): C[] {
  const q = parseQuery(raw);
  if (q.terms.length === 0) return commits;
  return commits.filter(c => commitMatchesQuery(c, q));
}

/** True when the raw query uses any structured `field:` term (for UX hints). */
export function isStructuredQuery(raw: string): boolean {
  return parseQuery(raw).terms.some(t => t.field !== 'text');
}
