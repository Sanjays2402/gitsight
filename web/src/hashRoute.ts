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
 *   graph                           bare view name = just the tab, no params
 * Refs run through the compare sanitiser, a sha through `sanitizeSha`, and a
 * vs-email through `sanitizeEmail`, so a crafted hash can't inject a flag/
 * space toward the companion.
 *
 * Tests: web/src/hashRoute.test.mjs
 */

import { sanitizeRef } from './compareFormat.ts';

/** Views that participate in hash routing. */
export type RouteView = 'graph' | 'activity' | 'contributors' | 'blame' | 'compare' | 'stashes';

const ROUTE_VIEWS: RouteView[] = ['graph', 'activity', 'contributors', 'blame', 'compare', 'stashes'];

export interface CompareRoute {
  view: 'compare';
  base: string;
  head: string;
}

export interface ContributorsRoute {
  view: 'contributors';
  /** Exactly two author emails to pre-load a comparison (W47). */
  vs: [string, string];
}

export interface PlainRoute {
  view: Exclude<RouteView, 'compare' | 'contributors'>;
  /**
   * Only on a graph permalink (`#commit/<sha>`, W27): the commit to open
   * the detail panel for. Absent for a bare view route.
   */
  sha?: string;
}

/** A bare contributors tab (no comparison) shares the PlainRoute-ish shape. */
export interface ContributorsBareRoute {
  view: 'contributors';
  vs?: undefined;
}

export type Route = CompareRoute | ContributorsRoute | ContributorsBareRoute | PlainRoute;

/** True when a string names a routable view. */
export function isRouteView(v: string): v is RouteView {
  return (ROUTE_VIEWS as string[]).includes(v);
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
  if (route.view === 'graph' && route.sha) {
    const sha = sanitizeSha(route.sha);
    return sha ? `commit/${sha}` : '';
  }
  return route.view === 'graph' ? '' : route.view;
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
