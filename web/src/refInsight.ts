/**
 * Pure ref-detail insight for the rail popover (W29).
 *
 * DOM-free + framework-free + NO @shared import, so it's unit-tested under
 * node --test. Given the loaded snapshot's commits (each carrying sha +
 * parents) and two tip shas, it computes everything the ref-detail popover
 * shows WITHOUT a backend round-trip:
 *   - the tip commit's identity (subject/author/date), looked up by sha;
 *   - ahead/behind counts vs another ref (usually HEAD), via a bounded
 *     reachability walk over the in-memory parent graph;
 *   - whether the comparison is exact or capped (the snapshot is --max'd,
 *     so a parent off the loaded window means we can't be sure).
 *
 * "Ahead" = commits reachable from THIS ref but not the other; "behind" =
 * reachable from the other but not this — the same sense `git rev-list
 * --left-right base...head` uses (this ref as head).
 *
 * Tests: web/src/refInsight.test.mjs
 */

/** Minimal commit shape: a sha + its parent shas. */
export interface GraphNode {
  sha: string;
  parents: string[];
}

/** A commit's display fields, when found in the loaded window. */
export interface TipCommit {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
}

export interface RefInsight {
  /** The tip commit, or null when its sha isn't in the loaded window. */
  tip: TipCommit | null;
  /** Commits reachable from this ref but not the compare ref. */
  ahead: number;
  /** Commits reachable from the compare ref but not this ref. */
  behind: number;
  /**
   * False when the reachability walk hit a parent outside the loaded
   * (--max-capped) window, so ahead/behind are lower bounds, not exact.
   */
  exact: boolean;
}

/**
 * Collect the set of shas reachable from `start` (inclusive) by walking
 * parents within the provided node map. Sets `truncated` true (via the
 * returned flag) when a parent sha isn't in the map — i.e. history was
 * capped below this ancestry.
 */
export function reachableFrom(
  start: string,
  nodes: Map<string, GraphNode>,
): { set: Set<string>; truncated: boolean } {
  const set = new Set<string>();
  let truncated = false;
  if (!start) return { set, truncated };
  const stack = [start];
  while (stack.length) {
    const sha = stack.pop()!;
    if (set.has(sha)) continue;
    const node = nodes.get(sha);
    if (!node) {
      // The start (or a parent) isn't in the loaded window.
      truncated = true;
      continue;
    }
    set.add(sha);
    for (const p of node.parents) {
      if (!set.has(p)) stack.push(p);
    }
  }
  return { set, truncated };
}

/** Index a commit list into a sha -> node map for the walks. */
export function indexNodes(commits: GraphNode[]): Map<string, GraphNode> {
  const map = new Map<string, GraphNode>();
  for (const c of commits) map.set(c.sha, { sha: c.sha, parents: c.parents ?? [] });
  return map;
}

/**
 * Compute ahead/behind between a ref tip and a compare tip over the loaded
 * graph. Symmetric-difference of the two reachable sets. `exact` is false
 * when either walk was truncated by the history cap.
 */
export function aheadBehind(
  refTip: string,
  compareTip: string,
  nodes: Map<string, GraphNode>,
): { ahead: number; behind: number; exact: boolean } {
  if (!refTip || !compareTip || refTip === compareTip) {
    return { ahead: 0, behind: 0, exact: true };
  }
  const a = reachableFrom(refTip, nodes);
  const b = reachableFrom(compareTip, nodes);
  let ahead = 0;
  let behind = 0;
  for (const sha of a.set) if (!b.set.has(sha)) ahead++;
  for (const sha of b.set) if (!a.set.has(sha)) behind++;
  return { ahead, behind, exact: !a.truncated && !b.truncated };
}

/** Full commit list element (a superset of GraphNode used for the tip lookup). */
export interface InsightCommit extends GraphNode {
  shortSha: string;
  author: string;
  date: string;
  subject: string;
}

/**
 * Build the ref-detail insight: the tip commit's identity + ahead/behind vs
 * a compare sha. `commits` is the loaded snapshot list (newest-first);
 * `refTip` the ref's tip sha; `compareTip` usually HEAD's tip sha.
 */
export function buildRefInsight(
  commits: InsightCommit[],
  refTip: string,
  compareTip: string,
): RefInsight {
  const nodes = indexNodes(commits);
  const tipCommit = commits.find(c => c.sha === refTip);
  const tip: TipCommit | null = tipCommit
    ? {
        sha: tipCommit.sha,
        shortSha: tipCommit.shortSha,
        author: tipCommit.author,
        date: tipCommit.date,
        subject: tipCommit.subject,
      }
    : null;
  const { ahead, behind, exact } = aheadBehind(refTip, compareTip, nodes);
  return { tip, ahead, behind, exact };
}

/**
 * One-line summary of ahead/behind for the popover header. "up to date"
 * when level; otherwise "N ahead, M behind" trimming a zero side. A `~`
 * prefix marks an inexact (history-capped) count.
 */
export function aheadBehindLabel(insight: RefInsight): string {
  const approx = insight.exact ? '' : '~';
  if (insight.ahead === 0 && insight.behind === 0) return 'up to date with HEAD';
  const parts: string[] = [];
  if (insight.ahead > 0) parts.push(`${approx}${insight.ahead} ahead`);
  if (insight.behind > 0) parts.push(`${approx}${insight.behind} behind`);
  return parts.join(', ');
}

// ── Rail sort command-palette source (W119) ──────────────────────────

/** A palette action for the W110/W113 rail divergence sort (W119). */
export type RailSortPaletteAction = 'rail-divergence' | 'rail-natural';

/** One Cmd-K entry that toggles the rail sort (W119, data only). */
export interface RailSortPaletteItem {
  action: RailSortPaletteAction;
  label: string;
}

/**
 * Build the command-palette source for the rail's "most diverged" sort (W119),
 * so the W110 toggle + its W113 deep link are reachable from Cmd-K, not just the
 * rail header — mirroring the W82 blame-author / W87 compare sources. Pure +
 * data only (the view maps each entry to a real PaletteItem with its run): when
 * the sort is on, the only useful action is turning it back to natural order;
 * when it's off, the only one is sorting by divergence. So the source returns a
 * single item that flips the current state, keeping the palette uncluttered.
 */
export function railSortPaletteItems(sortByDivergence: boolean): RailSortPaletteItem[] {
  return sortByDivergence
    ? [{ action: 'rail-natural', label: 'Rail: sort branches alphabetically' }]
    : [{ action: 'rail-divergence', label: 'Rail: sort branches by divergence' }];
}
