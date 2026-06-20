/**
 * Pure helpers for the Branch Comparison Summary feature (F26).
 *
 * Renders a one-line summary from `git rev-list --left-right --count` plus
 * `git diff --shortstat` plus a small contributor breakdown from
 * `git shortlog -sne`. Each parser is isolated so the controller can mock the
 * shell calls in tests and focus the unit tests here on the wire format.
 */

export interface AheadBehind { ahead: number; behind: number; }

export interface DiffShortStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface ContributorRow { name: string; email: string; commits: number; }

export interface BranchCompareSummary {
  base: string;
  head: string;
  /** Number of commits unique to each side (rev-list --left-right --count). */
  counts: AheadBehind;
  /** Diff shortstat (files, +, -). */
  diff: DiffShortStat;
  /** Top contributors on the head side (sorted desc by commit count). */
  topContributors: ContributorRow[];
  /** Total contributors on the head side (so we can say "+3 others"). */
  contributorTotal: number;
}

/** Parse `git rev-list --left-right --count base...head` → ahead / behind. */
export function parseLeftRightCount(out: string): AheadBehind {
  // Output is two whitespace-separated ints: behind <TAB> ahead (left=base, right=head).
  const parts = out.trim().split(/\s+/);
  if (parts.length < 2) return { ahead: 0, behind: 0 };
  const behind = parseIntSafe(parts[0]);
  const ahead = parseIntSafe(parts[1]);
  return { ahead, behind };
}

/** Parse `git diff --shortstat base...head` → files / + / -. */
export function parseShortStat(out: string): DiffShortStat {
  const empty = { filesChanged: 0, insertions: 0, deletions: 0 };
  const line = out.trim();
  if (!line) return empty;
  const files = /(\d+) files? changed/.exec(line);
  const ins = /(\d+) insertions?\(\+\)/.exec(line);
  const del = /(\d+) deletions?\(-\)/.exec(line);
  return {
    filesChanged: files ? +files[1] : 0,
    insertions: ins ? +ins[1] : 0,
    deletions: del ? +del[1] : 0,
  };
}

/** Parse `git shortlog -sne base..head` → contributor rows (desc by commits). */
export function parseShortlog(out: string): ContributorRow[] {
  const rows: ContributorRow[] = [];
  for (const raw of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s+<(.+?)>\s*$/.exec(raw);
    if (!m) continue;
    rows.push({ commits: +m[1], name: m[2], email: m[3] });
  }
  // shortlog -sne already sorts desc, but sort defensively.
  rows.sort((a, b) => b.commits - a.commits);
  return rows;
}

/** One-line summary suitable for a status message / notification. */
export function summariseCompare(s: BranchCompareSummary): string {
  const a = s.counts.ahead;
  const b = s.counts.behind;
  const bits: string[] = [];
  bits.push(`${a} ahead`);
  bits.push(`${b} behind`);
  bits.push(`${s.diff.filesChanged} file${s.diff.filesChanged === 1 ? '' : 's'}`);
  if (s.diff.insertions || s.diff.deletions) {
    bits.push(`+${s.diff.insertions}/-${s.diff.deletions}`);
  }
  if (s.topContributors.length) {
    const top = s.topContributors.slice(0, 2).map(c => c.name).join(', ');
    const extra = Math.max(0, s.contributorTotal - 2);
    bits.push(extra > 0 ? `${top} +${extra} others` : top);
  }
  return `${s.head} vs ${s.base}  ·  ${bits.join('  ·  ')}`;
}

/** Multi-line markdown body for the QuickPick `detail` / tooltip. */
export function formatCompareMarkdown(s: BranchCompareSummary): string {
  const lines: string[] = [];
  lines.push(`## ${s.head} vs ${s.base}`);
  lines.push('');
  lines.push(`- **${s.counts.ahead}** commit${s.counts.ahead === 1 ? '' : 's'} ahead`);
  lines.push(`- **${s.counts.behind}** commit${s.counts.behind === 1 ? '' : 's'} behind`);
  lines.push(`- **${s.diff.filesChanged}** file${s.diff.filesChanged === 1 ? '' : 's'} changed (+${s.diff.insertions} / -${s.diff.deletions})`);
  if (s.topContributors.length) {
    lines.push('');
    lines.push('**Contributors on this side:**');
    for (const c of s.topContributors) {
      lines.push(`- ${c.name} <${c.email}> — ${c.commits} commit${c.commits === 1 ? '' : 's'}`);
    }
    const extra = Math.max(0, s.contributorTotal - s.topContributors.length);
    if (extra > 0) lines.push(`- … and ${extra} more`);
  }
  return lines.join('\n');
}

function parseIntSafe(s: string): number {
  const n = parseInt((s ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
