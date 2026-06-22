/**
 * Pure helpers for the "What's mine?" dashboard (F100).
 *
 * The dashboard pulls from three GitHub surfaces and one local-git
 * surface:
 *
 *   1. PRs authored by me + open (gh search prs --author=@me --state=open)
 *   2. PRs awaiting my review (gh search prs --review-requested=@me --state=open)
 *   3. Issues assigned to me  (gh search issues --assignee=@me --state=open)
 *   4. My recent commits in this repo (git log --author=<self-email>
 *      --since=Nd) — the "have I shipped this week?" signal
 *
 * This module owns the pure shaping: parsing each gh JSON shape into
 * a unified DashboardItem, classifying urgency (review-required >
 * changes-requested > assigned > authored), and grouping into the
 * picker's tree-of-trees structure.
 *
 * Pure - no vscode, no child_process. Tests in test/git/whatsMine.test.ts.
 */

export type DashboardKind = 'pr-authored' | 'pr-review' | 'issue-assigned' | 'recent-commit';

export type DashboardUrgency = 'overdue' | 'today' | 'this-week' | 'idle';

export interface DashboardItem {
  kind: DashboardKind;
  /** PR/issue number; for recent-commit this is undefined. */
  number?: number;
  title: string;
  url?: string;
  repoSlug?: string;
  /** ISO 8601. */
  updatedAt: string;
  /** Set for PRs. */
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
  /** For PR-review: review decision (review_required, etc). */
  reviewDecision?: 'review-required' | 'changes-requested' | 'approved' | 'commented' | 'unknown';
  /** True when the PR or issue is a draft. */
  isDraft?: boolean;
  /** For recent-commit. */
  shortSha?: string;
  authorLogin?: string;
}

/**
 * Parse `gh search prs --json number,title,url,repository,updatedAt,
 * isDraft,reviewDecision,state` output for the "authored by me" feed.
 * Tolerant of the same field shapes as F75 prReviewInbox.
 */
export function parseAuthoredPrs(raw: string): DashboardItem[] {
  return parsePrJson(raw, 'pr-authored');
}

export function parseReviewRequestedPrs(raw: string): DashboardItem[] {
  return parsePrJson(raw, 'pr-review');
}

function parsePrJson(raw: string, kind: DashboardKind): DashboardItem[] {
  if (!raw || !raw.trim()) return [];
  let arr: any;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: DashboardItem[] = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const number = Number(r.number ?? 0);
    if (!Number.isFinite(number) || number <= 0) continue;
    out.push({
      kind,
      number,
      title: String(r.title ?? '(no title)'),
      url: String(r.url ?? ''),
      repoSlug: extractRepoSlug(r),
      updatedAt: String(r.updatedAt ?? ''),
      state: normaliseState(r.state),
      reviewDecision: normaliseReviewDecision(r.reviewDecision),
      isDraft: !!r.isDraft,
      authorLogin: String(r.author?.login ?? ''),
    });
  }
  return out;
}

export function parseAssignedIssues(raw: string): DashboardItem[] {
  if (!raw || !raw.trim()) return [];
  let arr: any;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: DashboardItem[] = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const number = Number(r.number ?? 0);
    if (!Number.isFinite(number) || number <= 0) continue;
    out.push({
      kind: 'issue-assigned',
      number,
      title: String(r.title ?? '(no title)'),
      url: String(r.url ?? ''),
      repoSlug: extractRepoSlug(r),
      updatedAt: String(r.updatedAt ?? ''),
      state: (String(r.state ?? '').toUpperCase() === 'CLOSED') ? 'CLOSED' : 'OPEN',
    });
  }
  return out;
}

/**
 * Parse the recent-commits stream from `git log --author=<email>
 * --pretty=format:%H|%h|%aI|%s --since=<n>d`. One commit per line.
 */
export function parseRecentCommits(raw: string, opts: { authorLogin?: string } = {}): DashboardItem[] {
  if (!raw) return [];
  const out: DashboardItem[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    if (parts.length < 4) continue;
    const [longSha, shortSha, iso, ...rest] = parts;
    // Require every leading field to be non-empty - empty values
    // indicate a malformed line (e.g. `||||` slipped through the
    // initial split-length check).
    if (!longSha || !shortSha || !iso) continue;
    const subject = rest.join('|').trim();
    if (!subject) continue;
    out.push({
      kind: 'recent-commit',
      title: subject,
      updatedAt: iso,
      shortSha,
      authorLogin: opts.authorLogin,
    });
  }
  return out;
}

function extractRepoSlug(r: any): string {
  const repo = r?.repository;
  if (!repo) return '';
  if (typeof repo === 'string') return repo;
  const owner = repo.owner?.login ?? repo.owner?.name ?? '';
  const name = repo.name ?? repo.nameWithOwner?.split('/')?.pop() ?? '';
  if (typeof repo.nameWithOwner === 'string' && repo.nameWithOwner.includes('/')) return repo.nameWithOwner;
  if (owner && name) return `${owner}/${name}`;
  return name || '';
}

function normaliseState(raw: any): 'OPEN' | 'CLOSED' | 'MERGED' {
  const u = String(raw ?? '').toUpperCase();
  if (u === 'CLOSED') return 'CLOSED';
  if (u === 'MERGED') return 'MERGED';
  return 'OPEN';
}

function normaliseReviewDecision(raw: any): DashboardItem['reviewDecision'] {
  const u = String(raw ?? '').toUpperCase().trim();
  if (!u) return 'unknown';
  if (u === 'REVIEW_REQUIRED')   return 'review-required';
  if (u === 'CHANGES_REQUESTED') return 'changes-requested';
  if (u === 'APPROVED')          return 'approved';
  if (u === 'COMMENTED')         return 'commented';
  return 'unknown';
}

/**
 * Classify how urgent an item is for the user to look at. Used to
 * pick the row glyph + sort order.
 *
 *   overdue   — needs-your-review PR with no reply, > 3 days idle
 *   today     — updated within the last 24h
 *   this-week — updated within the last 7 days
 *   idle      — older than a week, you've forgotten about it
 */
export function classifyUrgency(item: DashboardItem, now: Date = new Date()): DashboardUrgency {
  if (!item.updatedAt) return 'idle';
  const t = Date.parse(item.updatedAt);
  if (!Number.isFinite(t)) return 'idle';
  const ageMs = now.getTime() - t;
  const ageDays = ageMs / 86_400_000;
  // PR-review is the only "external pressure" surface - escalate
  // its overdue threshold (3 days) over the more passive surfaces.
  if (item.kind === 'pr-review') {
    if (item.reviewDecision === 'review-required' && ageDays > 3) return 'overdue';
  }
  if (ageDays < 1) return 'today';
  if (ageDays < 7) return 'this-week';
  return 'idle';
}

/**
 * Pick the row glyph for a DashboardItem. Uses VS Code's $(name)
 * codicons. Kept here so the picker label stays pure.
 */
export function glyphForItem(item: DashboardItem): string {
  if (item.kind === 'pr-authored') {
    if (item.isDraft) return 'git-pull-request-draft';
    if (item.state === 'MERGED') return 'git-merge';
    return 'git-pull-request';
  }
  if (item.kind === 'pr-review') {
    if (item.reviewDecision === 'changes-requested') return 'request-changes';
    if (item.reviewDecision === 'approved') return 'pass';
    return 'git-pull-request';
  }
  if (item.kind === 'issue-assigned') {
    return item.state === 'CLOSED' ? 'issue-closed' : 'issues';
  }
  return 'git-commit';
}

/**
 * Sort items within a section by urgency descending then updatedAt
 * descending. Stable: equal keys preserve input order.
 */
export function sortBySectionOrder(items: DashboardItem[], now: Date = new Date()): DashboardItem[] {
  const rank: Record<DashboardUrgency, number> = { overdue: 0, today: 1, 'this-week': 2, idle: 3 };
  return items.slice().sort((a, b) => {
    const ra = rank[classifyUrgency(a, now)];
    const rb = rank[classifyUrgency(b, now)];
    if (ra !== rb) return ra - rb;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
}

export interface DashboardSection {
  kind: DashboardKind;
  title: string;
  items: DashboardItem[];
}

/**
 * Group raw items into the four canonical sections in display order:
 *
 *   1. PRs needing your review   (external pressure - top of mind)
 *   2. PRs you authored          (what you've put up)
 *   3. Issues assigned to you    (what you owe)
 *   4. Your recent commits       (what you've shipped lately)
 *
 * Empty sections are still emitted so the picker shows the structure
 * consistently across runs. The caller decides whether to render a
 * placeholder row.
 */
export function buildSections(items: DashboardItem[], now: Date = new Date()): DashboardSection[] {
  const review = sortBySectionOrder(items.filter(i => i.kind === 'pr-review'), now);
  const authored = sortBySectionOrder(items.filter(i => i.kind === 'pr-authored'), now);
  const issues = sortBySectionOrder(items.filter(i => i.kind === 'issue-assigned'), now);
  const commits = sortBySectionOrder(items.filter(i => i.kind === 'recent-commit'), now);
  return [
    { kind: 'pr-review',      title: 'PRs needing your review',  items: review },
    { kind: 'pr-authored',    title: 'PRs you authored',         items: authored },
    { kind: 'issue-assigned', title: 'Issues assigned to you',   items: issues },
    { kind: 'recent-commit',  title: 'Your recent commits',      items: commits },
  ];
}

/**
 * Summary line for the picker header. "3 PRs need your review · 2
 * yours awaiting feedback · 1 issue assigned · 14 commits this week".
 */
export function describeSummary(sections: DashboardSection[]): string {
  const r = sections.find(s => s.kind === 'pr-review')?.items.length ?? 0;
  const a = sections.find(s => s.kind === 'pr-authored')?.items.length ?? 0;
  const i = sections.find(s => s.kind === 'issue-assigned')?.items.length ?? 0;
  const c = sections.find(s => s.kind === 'recent-commit')?.items.length ?? 0;
  const parts: string[] = [];
  parts.push(`${r} PR${r === 1 ? '' : 's'} need${r === 1 ? 's' : ''} your review`);
  parts.push(`${a} authored`);
  parts.push(`${i} issue${i === 1 ? '' : 's'} assigned`);
  parts.push(`${c} recent commit${c === 1 ? '' : 's'}`);
  return parts.join(' \u00b7 ');
}

/**
 * Format the picker label for an item.
 *
 *   PR-authored / PR-review:   owner/repo#NN  Title
 *   Issue-assigned:            owner/repo#NN  Title
 *   Recent-commit:             abc1234  Subject
 */
export function describeItemLabel(item: DashboardItem): string {
  if (item.kind === 'recent-commit') {
    return `${item.shortSha ?? ''}  ${item.title}`.trim();
  }
  const slug = item.repoSlug ? item.repoSlug + '#' : '#';
  return `${slug}${item.number ?? ''}  ${item.title}`.trim();
}

/**
 * Format the secondary description.
 */
export function describeItemDetail(item: DashboardItem, now: Date = new Date()): string {
  const parts: string[] = [];
  const urg = classifyUrgency(item, now);
  if (urg === 'overdue') parts.push('overdue');
  else if (urg === 'today') parts.push('today');
  else if (urg === 'this-week') parts.push('this week');
  if (item.kind === 'pr-authored' && item.isDraft) parts.push('draft');
  if (item.kind === 'pr-review') {
    if (item.reviewDecision === 'changes-requested') parts.push('changes requested');
    else if (item.reviewDecision === 'approved') parts.push('approved');
    else if (item.reviewDecision === 'commented') parts.push('commented');
  }
  if (item.kind === 'recent-commit' && item.authorLogin) parts.push(item.authorLogin);
  return parts.join(' \u00b7 ');
}
