/**
 * Pure URL-hash routing for shareable deep links (W24; commit permalinks W27).
 *
 * DOM-free + framework-free so it's unit-tested under node --test. Encodes
 * the active view's deep-linkable state into `location.hash` and parses it
 * back, so a comparison (W24), a focused commit (W27), or just which tab
 * you're on survives a reload and can be copied/bookmarked.
 *
 * Hash grammar (after the leading '#'):
 *   compare?base=<ref>&head=<ref>   the Compare view, pre-loaded
 *   commit/<sha>                    the graph with a commit detail open
 *   contributors?vs=<email>,<email> the contributor comparison, pre-loaded
 *   activity?year=<YYYY>&metric=churn   the calendar scoped to a year/metric
 *   blame?path=<path>&rev=<ref>&line=<N>  a file's blame, jumped to a line
 *   graph                           bare view name = just the tab, no params
 * Refs run through the compare sanitiser, a sha through `sanitizeSha`, a
 * vs-email through `sanitizeEmail`, a year through `sanitizeYear`, and a blame
 * path through `sanitizePath`, so a crafted hash can't inject a flag/space
 * toward the companion.
 *
 * Tests: web/src/hashRoute.test.mjs
 */

import { sanitizeRef } from './compareFormat.ts';

/** Views that participate in hash routing. */
export type RouteView = 'graph' | 'activity' | 'contributors' | 'blame' | 'compare' | 'stashes';

const ROUTE_VIEWS: RouteView[] = ['graph', 'activity', 'contributors', 'blame', 'compare', 'stashes'];

/** The activity metric a calendar deep-link can carry (W48). */
export type RouteActivityMetric = 'commits' | 'churn';

export interface CompareRoute {
  view: 'compare';
  base: string;
  head: string;
}

export interface ActivityRoute {
  view: 'activity';
  /** A calendar year to scope to (W48), or absent/null for the rolling window. */
  year?: number | null;
  /** Which metric the cells count (W48): 'churn' is the only non-default. */
  metric?: RouteActivityMetric;
}

export interface ContributorsRoute {
  view: 'contributors';
  /** Exactly two author emails to pre-load a comparison (W47). */
  vs: [string, string];
}

export interface BlameRoute {
  view: 'blame';
  /** The file path to blame (W57). Required; a blank path degrades to the bare tab. */
  path: string;
  /** The revision to blame at (W57), or absent for HEAD. */
  rev?: string;
  /** A 1-based line to jump to once the heatmap renders (W57). */
  line?: number;
}

export interface StashesRoute {
  view: 'stashes';
  /** A stash filter query to pre-fill (W63). Required; a blank degrades to the bare tab. */
  q: string;
}

export interface PlainRoute {
  view: Exclude<RouteView, 'compare' | 'contributors' | 'activity' | 'blame' | 'stashes'>;
  /**
   * Only on a graph permalink (`#commit/<sha>`, W27): the commit to open
   * the detail panel for. Absent for a bare view route.
   */
  sha?: string;
}

/** A bare blame tab (no file) shares the PlainRoute-ish shape. */
export interface BlameBareRoute {
  view: 'blame';
  path?: undefined;
}

/** A bare contributors tab (no comparison) shares the PlainRoute-ish shape. */
export interface ContributorsBareRoute {
  view: 'contributors';
  vs?: undefined;
}

/** A bare stashes tab (no filter) shares the PlainRoute-ish shape (W63). */
export interface StashesBareRoute {
  view: 'stashes';
  q?: undefined;
}

export type Route =
  | CompareRoute
  | ContributorsRoute
  | ContributorsBareRoute
  | ActivityRoute
  | BlameRoute
  | BlameBareRoute
  | StashesRoute
  | StashesBareRoute
  | PlainRoute;

/** True when a string names a routable view. */
export function isRouteView(v: string): v is RouteView {
  return (ROUTE_VIEWS as string[]).includes(v);
}

/**
 * Normalise + validate a calendar year for an activity deep-link (W48).
 * Accepts a plausible 4-digit year (1970-9999); returns null for anything
 * else so a junk `year=` param degrades to the rolling calendar rather than
 * scoping to nonsense. Mirrors the shared `isCalendarYear` guard.
 */
export function sanitizeYear(year: string | number | null | undefined): number | null {
  if (year === null || year === undefined || year === '') return null;
  const n = typeof year === 'number' ? year : Number(String(year).trim());
  if (!Number.isInteger(n) || n < 1970 || n > 9999) return null;
  return n;
}

/**
 * Normalise + validate an author email for a comparison deep-link (W47).
 * Mirrors the companion's `isPlausibleEmail`: non-empty, length-bounded, no
 * whitespace, and not flag-shaped (leading '-'), so a crafted `vs=` value
 * can't smuggle an option toward the `git log --author` read. Lowercased to
 * match the email-keyed contributor identity. Returns null for anything else.
 */
export function sanitizeEmail(email: string): string | null {
  const e = (email ?? '').trim().toLowerCase();
  if (!e || e.length > 320) return null;
  if (/\s/.test(e)) return null;
  if (e.startsWith('-')) return null;
  return e;
}

/**
 * Normalise + validate a commit sha for a permalink (W27). Accepts a hex
 * string of 4-64 chars (short sha through full sha-256), lowercased. Returns
 * null for anything else so a crafted `#commit/...` can't smuggle a path or
 * flag toward the companion's `git show`.
 */
export function sanitizeSha(sha: string): string | null {
  const s = (sha ?? '').trim().toLowerCase();
  return /^[0-9a-f]{4,64}$/.test(s) ? s : null;
}

/**
 * Normalise + validate a file path for a blame deep-link (W57). The companion
 * already guards the blame read with a `--` pathspec, but the hash value is
 * still sanitised so a crafted `#blame?path=` can't smuggle a flag or a
 * control char: leading whitespace is trimmed, a leading '-' (option-shaped)
 * is rejected, control characters fail, and the length is bounded. A leading
 * '/' or any '..' segment is rejected so the path stays repo-relative.
 * Returns null for anything unsafe so the deep link degrades to the bare tab.
 */
export function sanitizePath(path: string): string | null {
  const p = (path ?? '').trim();
  if (!p || p.length > 1024) return null;
  if (p.startsWith('-') || p.startsWith('/')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;
  // Reject parent-traversal segments (../ or a trailing/standalone ..).
  if (p.split('/').some(seg => seg === '..')) return null;
  return p;
}

/**
 * Normalise + validate a 1-based line number for a blame deep-link (W57).
 * Accepts a positive integer within a sane bound; returns null otherwise so a
 * junk `line=` param just drops the jump rather than passing nonsense on.
 */
export function sanitizeLine(line: string | number | null | undefined): number | null {
  if (line === null || line === undefined || line === '') return null;
  const n = typeof line === 'number' ? line : Number(String(line).trim());
  if (!Number.isInteger(n) || n < 1 || n > 100_000_000) return null;
  return n;
}

/**
 * Normalise + validate a stash filter query for a deep link (W63). The query
 * is purely a client-side substring match against stash subjects/branches (it
 * never reaches git), but the hash value is still cleaned so a crafted
 * `#stashes?q=` can't smuggle control characters into the DOM: it's trimmed,
 * control chars are stripped, and the length is bounded. Returns the cleaned
 * query, or null when it's empty so the link degrades to the bare stashes tab.
 */
export function sanitizeStashQuery(query: string | null | undefined): string | null {
  // eslint-disable-next-line no-control-regex
  const q = (query ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!q) return null;
  return q.slice(0, 200);
}

/**
 * Build the hash string (without the leading '#') for a route. A compare
 * route with both refs emits `compare?base=..&head=..`; a graph route with
 * a sha emits `commit/<sha>`; everything else is the bare view name.
 * Returns '' for the default (graph, no params) so we can clear the hash
 * rather than write `#graph`.
 */
export function buildHash(route: Route): string {
  if (route.view === 'compare') {
    const base = sanitizeRef(route.base);
    const head = sanitizeRef(route.head);
    if (!base || !head) return 'compare';
    const p = new URLSearchParams({ base, head });
    return `compare?${p.toString()}`;
  }
  if (route.view === 'contributors') {
    // A two-author comparison deep-link (W47): contributors?vs=a,b. Both
    // emails must sanitise; otherwise degrade to the bare contributors tab.
    if (route.vs) {
      const a = sanitizeEmail(route.vs[0]);
      const b = sanitizeEmail(route.vs[1]);
      if (a && b) {
        const p = new URLSearchParams({ vs: `${a},${b}` });
        return `contributors?${p.toString()}`;
      }
    }
    return 'contributors';
  }
  if (route.view === 'activity') {
    // A scoped-calendar deep-link (W48): activity?year=YYYY&metric=churn.
    // Only emit params that diverge from the defaults (rolling window +
    // commits) so the common case stays the bare `activity` tab.
    const p = new URLSearchParams();
    const year = sanitizeYear(route.year);
    if (year !== null) p.set('year', String(year));
    if (route.metric === 'churn') p.set('metric', 'churn');
    const qs = p.toString();
    return qs ? `activity?${qs}` : 'activity';
  }
  if (route.view === 'blame') {
    // A file-blame deep-link (W57): blame?path=..&rev=..&line=N. The path is
    // required; without a safe one, degrade to the bare blame tab. rev is
    // omitted for HEAD and line is omitted when there's no jump, so the URL
    // stays minimal.
    if (route.path) {
      const path = sanitizePath(route.path);
      if (path) {
        const p = new URLSearchParams({ path });
        const rev = route.rev ? sanitizeRef(route.rev) : null;
        if (rev && rev !== 'HEAD') p.set('rev', rev);
        const line = sanitizeLine(route.line);
        if (line !== null) p.set('line', String(line));
        return `blame?${p.toString()}`;
      }
    }
    return 'blame';
  }
  if (route.view === 'stashes') {
    // A filtered-stash deep-link (W63): stashes?q=<filter>. The query is
    // optional; without a non-empty one, degrade to the bare stashes tab.
    if (route.q) {
      const q = sanitizeStashQuery(route.q);
      if (q) {
        const p = new URLSearchParams({ q });
        return `stashes?${p.toString()}`;
      }
    }
    return 'stashes';
  }
  if (route.view === 'graph' && route.sha) {
    const sha = sanitizeSha(route.sha);
    return sha ? `commit/${sha}` : '';
  }
  // All non-graph views are handled above; PlainRoute is now graph-only, so a
  // bare graph route clears the hash.
  return '';
}

/**
 * Parse a `location.hash` value into a Route, or null when it carries no
 * routable view. Tolerates a leading '#', surrounding whitespace, and an
 * unknown view name (returns null). Unsafe refs/shas are dropped, degrading
 * a deep link to the bare tab rather than passing junk on.
 */
export function parseHash(hash: string): Route | null {
  let h = (hash ?? '').trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (!h) return null;

  // Commit permalink: commit/<sha> -> the graph with that detail open (W27).
  const commitMatch = /^commit\/(.+)$/.exec(h);
  if (commitMatch) {
    const sha = sanitizeSha(decodeURIComponent(commitMatch[1]));
    return sha ? { view: 'graph', sha } : { view: 'graph' };
  }

  const qIdx = h.indexOf('?');
  const viewName = (qIdx === -1 ? h : h.slice(0, qIdx)).toLowerCase();
  if (!isRouteView(viewName)) return null;

  if (viewName === 'compare') {
    const params = new URLSearchParams(qIdx === -1 ? '' : h.slice(qIdx + 1));
    const base = sanitizeRef(params.get('base') ?? '');
    const head = sanitizeRef(params.get('head') ?? '');
    if (base && head) return { view: 'compare', base, head };
    return { view: 'compare', base: '', head: '' };
  }

  // Contributor comparison deep-link (W47): contributors?vs=a,b.
  if (viewName === 'contributors') {
    const params = new URLSearchParams(qIdx === -1 ? '' : h.slice(qIdx + 1));
    const raw = params.get('vs') ?? '';
    if (raw) {
      const parts = raw.split(',').map(s => sanitizeEmail(decodeURIComponent(s)));
      if (parts.length === 2 && parts[0] && parts[1]) {
        return { view: 'contributors', vs: [parts[0], parts[1]] };
      }
    }
    return { view: 'contributors' };
  }

  // Scoped-calendar deep-link (W48): activity?year=YYYY&metric=churn. Both
  // params are optional; a junk year drops to the rolling window, and any
  // metric other than 'churn' falls back to the commits default.
  if (viewName === 'activity') {
    const params = new URLSearchParams(qIdx === -1 ? '' : h.slice(qIdx + 1));
    const year = sanitizeYear(params.get('year'));
    const metric: RouteActivityMetric = params.get('metric') === 'churn' ? 'churn' : 'commits';
    const route: ActivityRoute = { view: 'activity' };
    if (year !== null) route.year = year;
    if (metric === 'churn') route.metric = 'churn';
    return route;
  }

  // File-blame deep-link (W57): blame?path=..&rev=..&line=N. The path is
  // required + sanitised; without a safe one the link degrades to the bare
  // blame tab. A junk rev drops to HEAD; a junk line drops the jump.
  if (viewName === 'blame') {
    const params = new URLSearchParams(qIdx === -1 ? '' : h.slice(qIdx + 1));
    const rawPath = params.get('path');
    const path = rawPath ? sanitizePath(decodeURIComponent(rawPath)) : null;
    if (!path) return { view: 'blame' };
    const route: BlameRoute = { view: 'blame', path };
    const rev = sanitizeRef(params.get('rev') ?? '');
    if (rev && rev !== 'HEAD') route.rev = rev;
    const line = sanitizeLine(params.get('line'));
    if (line !== null) route.line = line;
    return route;
  }

  // Filtered-stash deep-link (W63): stashes?q=<filter>. The query is optional;
  // a blank/junk one degrades to the bare stashes tab.
  if (viewName === 'stashes') {
    const params = new URLSearchParams(qIdx === -1 ? '' : h.slice(qIdx + 1));
    const rawQ = params.get('q');
    const q = rawQ !== null ? sanitizeStashQuery(decodeURIComponent(rawQ)) : null;
    if (q) return { view: 'stashes', q };
    return { view: 'stashes' };
  }

  return { view: viewName as PlainRoute['view'] };
}

/**
 * Whether a freshly-built hash differs from the current one (ignoring a
 * leading '#'), so the caller can skip a no-op history write that would
 * otherwise risk a hashchange feedback loop.
 */
export function hashChanged(current: string, next: string): boolean {
  const norm = (s: string) => (s.startsWith('#') ? s.slice(1) : s);
  return norm(current ?? '') !== norm(next ?? '');
}
