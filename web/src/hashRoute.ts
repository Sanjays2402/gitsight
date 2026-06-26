/**
 * Pure URL-hash routing for shareable compare links (W24).
 *
 * DOM-free + framework-free so it's unit-tested under node --test. Encodes
 * the active view's deep-linkable state into `location.hash` and parses it
 * back, so a comparison (and which tab you're on) survives a reload and can
 * be copied/bookmarked. Today only the Compare view carries shareable
 * params (base/head); the scheme is extensible per-view.
 *
 * Hash grammar (after the leading '#'):
 *   compare?base=<ref>&head=<ref>
 *   graph            (bare view name = just the tab, no params)
 * Refs are validated with the same client-side sanitiser the compare form
 * uses, so a crafted hash can't inject a flag/space toward the companion.
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

export interface PlainRoute {
  view: Exclude<RouteView, 'compare'>;
}

export type Route = CompareRoute | PlainRoute;

/** True when a string names a routable view. */
export function isRouteView(v: string): v is RouteView {
  return (ROUTE_VIEWS as string[]).includes(v);
}

/**
 * Build the hash string (without the leading '#') for a route. A compare
 * route with both refs emits `compare?base=..&head=..`; everything else is
 * the bare view name. Returns '' for the default (graph, no params) so we
 * can clear the hash rather than write `#graph`.
 */
export function buildHash(route: Route): string {
  if (route.view === 'compare') {
    const base = sanitizeRef(route.base);
    const head = sanitizeRef(route.head);
    if (!base || !head) return 'compare';
    const p = new URLSearchParams({ base, head });
    return `compare?${p.toString()}`;
  }
  return route.view === 'graph' ? '' : route.view;
}

/**
 * Parse a `location.hash` value into a Route, or null when it carries no
 * routable view. Tolerates a leading '#', surrounding whitespace, and an
 * unknown view name (returns null). Unsafe refs are dropped, degrading a
 * compare link to the bare Compare tab rather than passing junk on.
 */
export function parseHash(hash: string): Route | null {
  let h = (hash ?? '').trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (!h) return null;

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
  return { view: viewName };
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
