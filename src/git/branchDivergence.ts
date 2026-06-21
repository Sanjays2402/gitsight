/**
 * Pure helpers for the Branch Divergence Visualiser (F36).
 *
 * When the user lands on a branch (via checkout / pull / branch-switcher /
 * `git checkout -`) we want to ask "are you behind the upstream you track?",
 * and if yes show one informative toast that names the top contributor on
 * the diverged side, with a one-click Rebase action.
 *
 * Pure — no vscode, no child_process. The watcher / UI layer lives in
 * src/views/branchDivergence.ts. Tested in test/git/branchDivergence.test.ts.
 */

export interface DivergenceCounts {
  /** Commits unique to the local branch (left of rev-list left-right). */
  ahead: number;
  /** Commits the upstream has that the local branch is missing. */
  behind: number;
}

/**
 * Parse `git rev-list --left-right --count <upstream>...<head>`.
 *
 * IMPORTANT: the order of `<a>...<b>` matters — the LEFT count is the side
 * unique to `<a>`. We always call this with upstream on the left, so:
 *   - left  = commits the *upstream* has that we don't → behind
 *   - right = commits *we* have that the upstream doesn't → ahead
 *
 * Output is "<left>\t<right>" possibly with a trailing newline.
 */
export function parseDivergenceCounts(raw: string): DivergenceCounts {
  const parts = (raw ?? '').trim().split(/\s+/);
  if (parts.length < 2) return { ahead: 0, behind: 0 };
  const behind = toUint(parts[0]);
  const ahead = toUint(parts[1]);
  return { ahead, behind };
}

export interface ContributorTally { name: string; email: string; commits: number; }

/**
 * Parse `git shortlog -sne <upstream>..<head>` (or any commit range). Returns
 * contributors sorted desc by commit count. Defensive against weird input.
 */
export function parseShortlog(raw: string): ContributorTally[] {
  const rows: ContributorTally[] = [];
  for (const line of (raw ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s+<(.+?)>\s*$/.exec(line);
    if (!m) continue;
    rows.push({ commits: +m[1], name: m[2].trim(), email: m[3].trim() });
  }
  rows.sort((a, b) => b.commits - a.commits);
  return rows;
}

export interface DivergenceContext {
  branch: string;
  upstream: string;
  counts: DivergenceCounts;
  topContributors: ContributorTally[];
  /** Total contributors on the diverged (behind) side. */
  contributorTotal: number;
}

/**
 * Build the user-facing message:
 *
 *   '`feature/x` is 4 commits behind `origin/main`. Top contributor: Alice.'
 *   '`feature/x` is 4 commits behind `origin/main`. Top contributors: Alice, Bob +3 others.'
 *
 * When the branch is also ahead, append a parenthetical so the user knows a
 * rebase is non-trivial.
 *
 * Returns `undefined` when the branch isn't behind — the watcher uses that
 * to decide whether to show a toast at all.
 */
export function describeDivergence(ctx: DivergenceContext): string | undefined {
  if (!ctx.counts.behind) return undefined;
  const verb = ctx.counts.behind === 1 ? 'commit' : 'commits';
  const bits: string[] = [];
  bits.push(`\`${ctx.branch}\` is ${ctx.counts.behind} ${verb} behind \`${ctx.upstream}\``);
  if (ctx.counts.ahead) {
    const av = ctx.counts.ahead === 1 ? 'commit' : 'commits';
    bits.push(`(and ${ctx.counts.ahead} ${av} ahead — rebase will need conflict resolution if these touch the same files)`);
  } else {
    bits[0] += '.';
  }
  if (ctx.topContributors.length) {
    const top = ctx.topContributors.slice(0, 2).map(c => c.name).join(', ');
    const extra = Math.max(0, ctx.contributorTotal - 2);
    const label = ctx.topContributors.length === 1 ? 'Top contributor' : 'Top contributors';
    bits.push(`${label}: ${top}${extra > 0 ? ` +${extra} others` : ''}.`);
  }
  return bits.join(' ');
}

/**
 * Decide whether the toast should be shown for a given divergence.
 *
 * We suppress two cases:
 *   - branch is not behind (nothing to nudge about)
 *   - the upstream is itself, e.g. "origin/main" being checked out directly
 *     (rare but possible — we don't want a self-referential message)
 */
export function shouldNotify(ctx: DivergenceContext): boolean {
  if (!ctx.counts.behind) return false;
  if (ctx.branch === ctx.upstream) return false;
  return true;
}

function toUint(s: string): number {
  const n = parseInt((s ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
