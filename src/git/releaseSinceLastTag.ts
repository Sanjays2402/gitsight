/**
 * Pure helpers for F117 - "Last release vs HEAD" CHANGELOG preview.
 *
 * Composes with F86 tag-on-merge: rather than wait until the user
 * runs the tag prompt, surface a continuous "what's accumulating
 * since the last tag" picker:
 *
 *   - parseDiffNumstat: count added / removed lines per file
 *   - summariseAccumulation: roll the commits + numstat rows into a
 *     headline (commits, files, +lines, -lines, bump verdict from
 *     classifyRangeBump, suggested next tag from suggestNextTag)
 *   - buildChangelogPreview: full markdown render of the section that
 *     would land in CHANGELOG.md if we shipped a release right now.
 *     Mirrors buildReleaseNotes from tagOnMerge.ts but with extra
 *     "diff stat" header rows that callers can paste into a draft.
 *
 * Pure - no fs, no vscode, no child_process. Reuses the conventional
 * commit classifier from tagOnMerge.ts.
 *
 * Tests in test/git/releaseSinceLastTag.test.ts.
 */

import {
  MergedCommit,
  SemverBump,
  classifyRangeBump,
  suggestNextTag,
  parseConventionalHeader,
} from './tagOnMerge';

export interface DiffNumstatRow {
  /** Repo-relative path. */
  path: string;
  /** Added line count; '-' from numstat (binary) becomes 0. */
  added: number;
  /** Removed line count; '-' from numstat (binary) becomes 0. */
  removed: number;
  /** True when numstat reported '-' (binary file). */
  binary: boolean;
}

const NUMSTAT_LINE_RE = /^(-|\d+)\t(-|\d+)\t(.+)$/;

/**
 * Parse the output of `git diff --numstat <range>` (or `--numstat -z`
 * for safety on paths with newlines, but the LF variant is fine for
 * almost every real repo).
 *
 * Lines that don't match are silently ignored.
 */
export function parseDiffNumstat(raw: string): DiffNumstatRow[] {
  if (!raw) return [];
  const out: DiffNumstatRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const m = NUMSTAT_LINE_RE.exec(line);
    if (!m) continue;
    const addedRaw = m[1];
    const removedRaw = m[2];
    const path = m[3].trim();
    if (!path) continue;
    const binary = addedRaw === '-' || removedRaw === '-';
    out.push({
      path,
      added: binary ? 0 : Number(addedRaw),
      removed: binary ? 0 : Number(removedRaw),
      binary,
    });
  }
  return out;
}

export interface AccumulationSummary {
  /** Number of analysed commits (input length). */
  commitCount: number;
  /** Number of touched files (numstat rows). */
  fileCount: number;
  added: number;
  removed: number;
  /** Binary-file count for the warning row. */
  binary: number;
  /** Per-conventional-type breakdown ('chore', 'feat', ...). */
  byType: Record<string, number>;
  /** Roll-up bump verdict from F86 helper. */
  bump: SemverBump;
  /** Suggested next tag from F86; undefined when bump='none' or previous tag isn't semver. */
  nextTag?: string;
  /** Top contributors by commit count (max 5). */
  topContributors: { name: string; commits: number }[];
}

export function summariseAccumulation(args: {
  commits: MergedCommit[];
  numstat: DiffNumstatRow[];
  previousTag?: string;
}): AccumulationSummary {
  const { commits, numstat, previousTag } = args;
  const byType: Record<string, number> = {};
  for (const c of commits) {
    const h = parseConventionalHeader(c.subject);
    const t = h?.type ?? 'other';
    byType[t] = (byType[t] ?? 0) + 1;
  }
  let added = 0, removed = 0, binary = 0;
  for (const r of numstat) {
    if (r.binary) binary += 1;
    added += r.added;
    removed += r.removed;
  }
  const bump = classifyRangeBump(commits);
  const nextTag = suggestNextTag(previousTag, commits);
  const contrib = new Map<string, number>();
  for (const c of commits) {
    const name = (c.author ?? '').trim();
    if (!name) continue;
    contrib.set(name, (contrib.get(name) ?? 0) + 1);
  }
  const topContributors = Array.from(contrib.entries())
    .map(([name, commits]) => ({ name, commits }))
    .sort((a, b) => {
      if (b.commits !== a.commits) return b.commits - a.commits;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 5);
  return {
    commitCount: commits.length,
    fileCount: numstat.length,
    added, removed, binary,
    byType,
    bump,
    nextTag,
    topContributors,
  };
}

/**
 * One-line headline for a status pill, info-message, or picker placeholder:
 *
 *   "47 commits since v1.2.0 - 12 features, 3 fixes - suggests v1.3.0 (minor)"
 *
 * When `previousTag` is undefined we say "since first commit".
 */
export function formatAccumulationHeadline(
  s: AccumulationSummary,
  previousTag: string | undefined,
): string {
  if (s.commitCount === 0) {
    return previousTag
      ? `No new commits since ${previousTag}.`
      : `No commits in the range.`;
  }
  const sinceLabel = previousTag ?? 'first commit';
  const ranges = describeByType(s.byType);
  const tagPart = s.nextTag ? ` - suggests \`${s.nextTag}\` (${s.bump})` : ` - no semver bump`;
  return `${s.commitCount} commit${s.commitCount === 1 ? '' : 's'} since ${sinceLabel}${ranges ? ` - ${ranges}` : ''}${tagPart}`;
}

function describeByType(byType: Record<string, number>): string {
  const ORDER = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'chore', 'build', 'ci', 'style', 'revert'];
  const parts: string[] = [];
  for (const t of ORDER) {
    const n = byType[t];
    if (!n) continue;
    parts.push(`${n} ${pluralise(t, n)}`);
  }
  // "other" bucket lumped at end, only if non-trivial.
  const other = byType['other'] ?? 0;
  if (other) parts.push(`${other} other`);
  return parts.slice(0, 4).join(', ');
}

function pluralise(type: string, n: number): string {
  if (type === 'feat') return n === 1 ? 'feature' : 'features';
  if (type === 'fix') return n === 1 ? 'fix' : 'fixes';
  if (type === 'perf') return n === 1 ? 'perf' : 'perf changes';
  if (type === 'chore') return n === 1 ? 'chore' : 'chores';
  if (type === 'docs') return n === 1 ? 'docs change' : 'docs changes';
  if (type === 'test') return n === 1 ? 'test' : 'tests';
  return n === 1 ? type : `${type} changes`;
}

/**
 * Full markdown CHANGELOG section, suitable for a scratch preview doc
 * or pasting into CHANGELOG.md. Combines summary header + buildReleaseNotes
 * shape from F86 with a "Touched files" appendix.
 *
 * Caller can pass `commitsCap=200` to bound the section size on huge ranges.
 */
export function buildChangelogPreview(args: {
  commits: MergedCommit[];
  numstat: DiffNumstatRow[];
  previousTag?: string;
  summary: AccumulationSummary;
  rangeRef?: string;
  commitsCap?: number;
  filesCap?: number;
}): string {
  const { commits, numstat, previousTag, summary, rangeRef } = args;
  const commitsCap = args.commitsCap ?? 200;
  const filesCap = args.filesCap ?? 200;

  const lines: string[] = [];
  const headerTag = summary.nextTag ?? '(unreleased)';
  lines.push(`## ${headerTag} (preview)`);
  lines.push('');
  lines.push(`_${formatAccumulationHeadline(summary, previousTag)}_`);
  if (rangeRef) {
    lines.push('');
    lines.push(`_range: \`${rangeRef}\`_`);
  }
  lines.push('');
  lines.push(`Files: ${summary.fileCount}, +${summary.added} / -${summary.removed} lines${summary.binary ? `, ${summary.binary} binary` : ''}`);

  // Section bodies (Breaking > Features > Fixes > Perf > Other).
  const breaking: MergedCommit[] = [];
  const features: MergedCommit[] = [];
  const fixes: MergedCommit[] = [];
  const perf: MergedCommit[] = [];
  const other: MergedCommit[] = [];
  for (const c of commits.slice(0, commitsCap)) {
    const h = parseConventionalHeader(c.subject);
    if (h?.breaking || /^BREAKING[\s-]?CHANGE:/im.test(c.body || '')) breaking.push(c);
    else if (h?.type === 'feat') features.push(c);
    else if (h?.type === 'fix') fixes.push(c);
    else if (h?.type === 'perf') perf.push(c);
    else other.push(c);
  }
  if (breaking.length) {
    lines.push('', '### Breaking changes');
    for (const c of breaking) lines.push(formatLine(c));
  }
  if (features.length) {
    lines.push('', '### Features');
    for (const c of features) lines.push(formatLine(c));
  }
  if (fixes.length) {
    lines.push('', '### Fixes');
    for (const c of fixes) lines.push(formatLine(c));
  }
  if (perf.length) {
    lines.push('', '### Performance');
    for (const c of perf) lines.push(formatLine(c));
  }
  if (other.length) {
    lines.push('', '### Other');
    for (const c of other) lines.push(formatLine(c));
  }
  if (commits.length > commitsCap) {
    lines.push('', `_(${commits.length - commitsCap} more commits omitted)_`);
  }

  if (summary.topContributors.length) {
    lines.push('', '### Contributors');
    lines.push(summary.topContributors.map(c => `${c.name} (${c.commits})`).join(', '));
  }

  if (numstat.length) {
    lines.push('', '### Touched files');
    const slice = [...numstat]
      .sort((a, b) => (b.added + b.removed) - (a.added + a.removed) || a.path.localeCompare(b.path))
      .slice(0, filesCap);
    lines.push('| File | +added | -removed | binary |');
    lines.push('| --- | ---:| ---:| ---|');
    for (const r of slice) {
      lines.push(`| \`${escapePipe(r.path)}\` | ${r.added} | ${r.removed} | ${r.binary ? 'yes' : ''} |`);
    }
    if (numstat.length > filesCap) {
      lines.push('', `_(${numstat.length - filesCap} more files omitted)_`);
    }
  }
  return lines.join('\n');
}

function formatLine(c: MergedCommit): string {
  return `- ${c.subject} (${c.shortSha})`;
}

function escapePipe(s: string): string { return s.replace(/\|/g, '\\|'); }
