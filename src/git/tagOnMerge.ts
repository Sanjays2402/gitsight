/**
 * Pure helpers for the Tag-on-Merge Prompt (F86).
 *
 * After a merge command lands a PR-shaped branch into `main`, this module:
 *   1. Inspects the merged commit range (PR commits or merge commit body).
 *   2. Classifies the semver bump from conventional-commit prefixes and
 *      BREAKING CHANGE trailers (major > minor > patch).
 *   3. Computes the next tag name by bumping the latest stable semver tag.
 *   4. Produces a draft release-notes body grouped by conventional type.
 *
 * Pure — no vscode, no child_process. Tests in test/git/tagOnMerge.test.ts.
 */

export type SemverBump = 'major' | 'minor' | 'patch' | 'none';

export interface MergedCommit {
  /** Full SHA. */
  sha: string;
  /** Short SHA (typically 7 chars). */
  shortSha: string;
  /** Subject line (first line of the message). */
  subject: string;
  /** Body lines below the subject (the trailer block included). */
  body: string;
  /** Optional author name for the notes table. */
  author?: string;
}

/**
 * Parsed conventional-commit header.
 *
 *   "feat(git): add branch picker" →
 *     { type: 'feat', scope: 'git', breaking: false, description: 'add branch picker' }
 *
 *   "fix!: drop deprecated flag" →
 *     { type: 'fix', scope: undefined, breaking: true, description: 'drop deprecated flag' }
 *
 *   "Random commit subject" → undefined (not conventional-shaped)
 */
export interface ParsedHeader {
  type: string;
  scope?: string;
  breaking: boolean;
  description: string;
}

const HEADER_RE = /^([a-z]+)(?:\(([^)]+)\))?(!?):\s+(.+)$/;

export function parseConventionalHeader(subject: string): ParsedHeader | undefined {
  if (!subject) return undefined;
  const m = HEADER_RE.exec(subject.trim());
  if (!m) return undefined;
  const [, type, scope, bang, description] = m;
  return {
    type,
    scope: scope || undefined,
    breaking: bang === '!',
    description: description.trim(),
  };
}

/**
 * Classify a single commit's semver impact. Reads both the header
 * (`feat!`, `fix!`, etc.) AND the body (for `BREAKING CHANGE:` trailers,
 * which can sit on a non-bang-typed commit when the breaking note was
 * added later via an amend).
 */
export function classifyCommitBump(commit: MergedCommit): SemverBump {
  const header = parseConventionalHeader(commit.subject);
  if (header?.breaking) return 'major';
  if (bodyDeclaresBreaking(commit.body)) return 'major';
  if (header?.type === 'feat') return 'minor';
  if (header?.type === 'fix') return 'patch';
  if (header?.type === 'perf') return 'patch';
  return 'none';
}

function bodyDeclaresBreaking(body: string): boolean {
  if (!body) return false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (/^BREAKING[\s-]?CHANGE\s*:/.test(line)) return true;
  }
  return false;
}

/**
 * Roll a commit range into a single bump verdict — the MAX bump observed
 * (major > minor > patch > none). Returns `'none'` for empty inputs.
 */
export function classifyRangeBump(commits: MergedCommit[]): SemverBump {
  const rank: Record<SemverBump, number> = { none: 0, patch: 1, minor: 2, major: 3 };
  let best: SemverBump = 'none';
  for (const c of commits) {
    const here = classifyCommitBump(c);
    if (rank[here] > rank[best]) best = here;
    if (best === 'major') return 'major';
  }
  return best;
}

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifier (e.g. 'rc.1'); undefined for stable. */
  pre?: string;
  /** Original tag prefix ('v' or ''). Preserved when emitting the next tag. */
  prefix: 'v' | '';
}

const SEMVER_RE = /^(v?)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemverTag(name: string): SemverParts | undefined {
  if (!name) return undefined;
  const m = SEMVER_RE.exec(name.trim());
  if (!m) return undefined;
  return {
    prefix: m[1] as 'v' | '',
    major: Number(m[2]),
    minor: Number(m[3]),
    patch: Number(m[4]),
    pre: m[5] || undefined,
  };
}

/**
 * Apply the bump and emit the next tag name. Pre-release suffixes are
 * DROPPED on bump — `v2.0.0-rc.1` + minor → `v2.1.0`, not
 * `v2.0.0-rc.1.minor` or `v2.1.0-rc.1`. The user can re-add a
 * pre-release manually if that's the workflow.
 *
 * Returns undefined when the bump is `'none'` (nothing to release).
 */
export function applyBump(parts: SemverParts, bump: SemverBump): string | undefined {
  if (bump === 'none') return undefined;
  let major = parts.major;
  let minor = parts.minor;
  let patch = parts.patch;
  if (bump === 'major') {
    major += 1; minor = 0; patch = 0;
  } else if (bump === 'minor') {
    minor += 1; patch = 0;
  } else {
    patch += 1;
  }
  return `${parts.prefix}${major}.${minor}.${patch}`;
}

/**
 * Convenience wrapper: parse the previous tag, classify the range, emit
 * the next tag. Returns undefined when the previous tag isn't semver OR
 * the range produces no bump.
 *
 * When `previousTag` is undefined (no prior tag in the repo), seeds with
 * `v0.1.0` for minor/major bumps and `v0.0.1` for patches — gives projects
 * a clean starting point that signals their first feature/breaking change.
 */
export function suggestNextTag(previousTag: string | undefined, commits: MergedCommit[]): string | undefined {
  const bump = classifyRangeBump(commits);
  if (bump === 'none') return undefined;
  if (!previousTag) {
    if (bump === 'patch') return 'v0.0.1';
    return 'v0.1.0';
  }
  const parts = parseSemverTag(previousTag);
  if (!parts) return undefined;
  return applyBump(parts, bump);
}

/**
 * Group merged commits into a release-notes draft body.
 *
 *   ## What's changed
 *
 *   ### Features
 *   - feat(git): add branch picker (a1b2c3d)
 *
 *   ### Fixes
 *   - fix(scaffold): regenerate clobbered subject (e4f5g6h)
 *
 *   ### Breaking changes
 *   - feat(api)!: rename foo() to bar() (h7i8j9k)
 *
 *   ## Contributors
 *   alice, bob
 *
 * Sections are emitted in order: Breaking → Features → Fixes → Performance →
 * Other (anything we didn't recognise as conventional). Empty sections are
 * skipped. Author list at the bottom dedups by name preserving first-seen
 * order so the top contributor lands first.
 */
export function buildReleaseNotes(args: {
  commits: MergedCommit[];
  range?: string;
  nextTag?: string;
}): string {
  const { commits, range, nextTag } = args;
  const breaking: MergedCommit[] = [];
  const features: MergedCommit[] = [];
  const fixes: MergedCommit[] = [];
  const perf: MergedCommit[] = [];
  const other: MergedCommit[] = [];
  for (const c of commits) {
    const header = parseConventionalHeader(c.subject);
    if (header?.breaking || bodyDeclaresBreaking(c.body)) {
      breaking.push(c);
    } else if (header?.type === 'feat') {
      features.push(c);
    } else if (header?.type === 'fix') {
      fixes.push(c);
    } else if (header?.type === 'perf') {
      perf.push(c);
    } else {
      other.push(c);
    }
  }
  const lines: string[] = [];
  if (nextTag) lines.push(`## ${nextTag}`, '');
  lines.push("## What's changed");
  if (range) {
    lines.push('');
    lines.push(`_range: \`${range}\`_`);
  }
  if (breaking.length) {
    lines.push('', '### Breaking changes');
    for (const c of breaking) lines.push(formatBulletLine(c));
  }
  if (features.length) {
    lines.push('', '### Features');
    for (const c of features) lines.push(formatBulletLine(c));
  }
  if (fixes.length) {
    lines.push('', '### Fixes');
    for (const c of fixes) lines.push(formatBulletLine(c));
  }
  if (perf.length) {
    lines.push('', '### Performance');
    for (const c of perf) lines.push(formatBulletLine(c));
  }
  if (other.length) {
    lines.push('', '### Other');
    for (const c of other) lines.push(formatBulletLine(c));
  }
  const contributors = collectContributors(commits);
  if (contributors.length) {
    lines.push('', '## Contributors', contributors.join(', '));
  }
  return lines.join('\n');
}

function formatBulletLine(c: MergedCommit): string {
  return `- ${c.subject} (${c.shortSha})`;
}

function collectContributors(commits: MergedCommit[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of commits) {
    const a = (c.author ?? '').trim();
    if (!a) continue;
    if (seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

/**
 * Detect whether the most recent commit looks like a PR-shape merge —
 * either a `Merge pull request #N` subject (default merge-commit shape)
 * or a `<subject> (#N)` shape (squash-merge default). Returns the PR
 * number when matched, undefined otherwise.
 *
 * Used by the prompt to decide whether to even ASK about a release tag
 * (we don't want to ask on every commit, only on merges).
 */
const MERGE_COMMIT_RE = /^Merge\s+pull\s+request\s+#(\d+)/i;
const SQUASH_MERGE_RE = /^.*\s+\(#(\d+)\)\s*$/;

export function detectMergedPrNumber(subject: string): number | undefined {
  if (!subject) return undefined;
  const m1 = MERGE_COMMIT_RE.exec(subject);
  if (m1) return Number(m1[1]);
  const m2 = SQUASH_MERGE_RE.exec(subject);
  if (m2) return Number(m2[1]);
  return undefined;
}
