/**
 * Pure helpers for the Recent Contributors hover (F81).
 *
 * Given the output of `git log -n<N> --format='%an<TAB>%ae<TAB>%aI' -- <file>`,
 * collapse the rows into a unique-contributors list (by email, falling back
 * to name when email is missing), preserving the most-recent commit date
 * per contributor. The result feeds two surfaces:
 *
 *   1. A FileDecorationProvider that puts a small badge on each tracked
 *      file in the explorer ("3" = 3 unique contributors in the last N
 *      commits) with a rich tooltip listing them.
 *
 *   2. A command picker (`gitsight.recentContributors.show`) that opens
 *      a QuickPick of contributors with their last-touch date and an
 *      action to filter the existing commits view by that author.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/recentContributors.test.ts.
 */

export interface RecentContributor {
  name: string;
  email: string;
  /** Most recent touch date for this contributor on this file. */
  lastDate: Date;
  /** Number of commits this contributor has on the file within the window. */
  commitCount: number;
}

export interface ScanOptions {
  /** Optional clock for testability; defaults to Date.now(). */
  now?: () => Date;
}

/**
 * Parse the stdout of:
 *
 *   git log -n<N> --no-merges --format=%an%x09%ae%x09%aI -- <file>
 *
 * (`%x09` = TAB). Returns one entry per UNIQUE contributor, sorted by
 * most-recent-touch descending. Email is the dedup key (falls back to
 * name + '@' when the email is empty).
 */
export function parseContributors(raw: string): RecentContributor[] {
  if (!raw) return [];
  const byKey = new Map<string, RecentContributor>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split('\t');
    if (cols.length < 3) continue;
    const name = (cols[0] ?? '').trim();
    const email = (cols[1] ?? '').trim();
    const dateStr = (cols[2] ?? '').trim();
    if (!name && !email) continue;
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) continue;
    const key = (email || `${name}@`).toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      existing.commitCount += 1;
      if (date.getTime() > existing.lastDate.getTime()) {
        existing.lastDate = date;
        // Newer commit's name/email wins on tie — git users sometimes
        // change handles, the newest one is the canonical surface.
        if (name) existing.name = name;
        if (email) existing.email = email;
      }
    } else {
      byKey.set(key, { name: name || email, email, lastDate: date, commitCount: 1 });
    }
  }
  const out = [...byKey.values()];
  out.sort((a, b) => b.lastDate.getTime() - a.lastDate.getTime());
  return out;
}

/**
 * Render a one-line "headline" suitable for a FileDecoration tooltip
 * header. Stable shape so tests can assert on it.
 *
 *   "3 contributors in the last 50 commits"
 */
export function describeHeadline(contributors: RecentContributor[], windowSize: number): string {
  const n = contributors.length;
  const cn = `${n} contributor${n === 1 ? '' : 's'}`;
  return `${cn} in the last ${windowSize} commit${windowSize === 1 ? '' : 's'}`;
}

/**
 * Single-line picker description: "Alice  ·  3 commits  ·  2d ago".
 * `relativeDate` should be the project's timeAgo() output.
 */
export function describeContributor(c: RecentContributor, relativeDate: string): string {
  const commits = `${c.commitCount} commit${c.commitCount === 1 ? '' : 's'}`;
  return `${c.name}  \u00b7  ${commits}  \u00b7  ${relativeDate}`;
}

/**
 * Build the markdown tooltip body. Caller provides the `relativeDateFor`
 * mapper to avoid pulling timeAgo into the pure module. Format:
 *
 *   - **Alice** \u00b7 3 commits \u00b7 2d ago
 *   - **Bob** \u00b7 1 commit \u00b7 last week
 */
export function buildTooltipMarkdown(
  contributors: RecentContributor[],
  relativeDateFor: (d: Date) => string,
): string {
  if (!contributors.length) return '_No recent contributors._';
  const lines: string[] = [];
  for (const c of contributors) {
    const commits = `${c.commitCount} commit${c.commitCount === 1 ? '' : 's'}`;
    lines.push(`- **${c.name}** \u00b7 ${commits} \u00b7 ${relativeDateFor(c.lastDate)}`);
  }
  return lines.join('\n');
}

/**
 * Decide the badge for the FileDecorationProvider. We use the contributor
 * count as a 1-2 character badge ("3", "10", "10+" for >9). Returns
 * undefined when the file has no contributors (don't pollute the explorer
 * with badges on every untracked file).
 */
export function badgeForCount(count: number): string | undefined {
  if (count <= 0) return undefined;
  if (count > 9) return '9+';
  return String(count);
}
