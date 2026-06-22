/**
 * Pure helpers for the Auto-Split Commit Suggester (F95).
 *
 * Extends F90 (diff size heuristic) with a coherence classifier that
 * groups a `huge` staged diff into per-commit suggestions. Given the
 * F90 numstat rows + the conventional-commit type extracted from the
 * SCM input, propose 2-4 logical clusters the user can split into.
 *
 * The clustering heuristic uses three independent signals:
 *
 *   1. TOP-LEVEL DIRECTORY    — `src/foo/...` vs `test/bar/...` are
 *      naturally separate commits. The top-level segment is the
 *      strongest cohesion signal in real-world monorepos.
 *
 *   2. NOISY vs CODE          — lockfiles, generated files, snapshots
 *      should ALWAYS be their own commit so a reviewer's eyes don't
 *      glaze on the real change. Re-uses isNoisyPath from F90.
 *
 *   3. FILE-TYPE STRATA       — `*.test.ts` and `*.spec.ts` form
 *      their own "tests" bucket; `*.md` / `*.txt` / `CHANGELOG*`
 *      form a "docs" bucket; everything else is "source".
 *
 * We compose the three signals into cluster IDs and rank clusters
 * by churn (added + deleted lines) so the user sees the biggest
 * chunk first. The output is suggestion shapes, not a literal git
 * plan — the view layer turns them into git-add commands.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/diffSplitSuggester.test.ts.
 */
import { DiffNumstatRow, isNoisyPath } from './diffSizeHeuristic';

export type ClusterKind =
  | 'lockfile'     // Lockfile / generated noise — first commit, always.
  | 'tests'        // *.test.* / *.spec.* / test/**/*
  | 'docs'         // *.md / *.txt / CHANGELOG / docs/**
  | 'snapshots'    // __snapshots__, .snap, .golden, .expected
  | 'source';      // Everything else (the real code).

export interface DiffCluster {
  /** Cluster classification. */
  kind: ClusterKind;
  /**
   * The top-level directory shared by every path in the cluster.
   * `'(repo root)'` when paths span multiple top-levels (rare but possible).
   */
  topLevel: string;
  /** Repo-relative paths in this cluster (sorted alphabetically). */
  paths: string[];
  /** Total added lines (excludes binary files which contribute 0). */
  added: number;
  /** Total deleted lines. */
  deleted: number;
  /** added + deleted (used for cluster ranking). */
  churn: number;
  /**
   * Suggested conventional-commit subject for this cluster. Honours the
   * user's chosen type when it's a good fit (e.g. `feat:` for source),
   * otherwise picks the obvious one (`test:` / `docs:` / `chore:` for
   * lockfiles + snapshots).
   */
  suggestedSubject: string;
}

const TEST_PATH_RE = /\.(test|spec)\.[a-zA-Z0-9]+$/;
const TEST_DIR_RE = /(^|\/)(test|tests|__tests__|spec)\//;
const DOCS_FILE_RE = /(^|\/)(readme|changelog|contributing|license)\b/i;
const DOCS_EXT_RE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const DOCS_DIR_RE = /(^|\/)(docs|documentation)\//;
const SNAPSHOT_FILE_RE = /(^|\/)__snapshots__\//;
const SNAPSHOT_EXT_RE = /\.(snap|golden|expected)$/i;

function classifyPath(p: string): ClusterKind {
  const lower = p.toLowerCase();
  if (SNAPSHOT_FILE_RE.test(lower) || SNAPSHOT_EXT_RE.test(lower)) return 'snapshots';
  if (isNoisyPath(p)) return 'lockfile';
  if (TEST_PATH_RE.test(lower) || TEST_DIR_RE.test(lower)) return 'tests';
  if (DOCS_DIR_RE.test(lower) || DOCS_EXT_RE.test(lower) || DOCS_FILE_RE.test(lower)) return 'docs';
  return 'source';
}

function topLevelOf(p: string): string {
  const slash = p.indexOf('/');
  return slash < 0 ? '(repo root)' : p.slice(0, slash);
}

export interface ClusterArgs {
  rows: DiffNumstatRow[];
  /** Conventional-commit type from the SCM input (e.g. `feat`/`fix`); used to pick the source cluster's subject. */
  preferredType?: string;
  /** Optional scope from SCM input. */
  preferredScope?: string;
}

/**
 * Group a numstat into 2-4 ranked clusters. Empty input -> [].
 *
 * Algorithm:
 *   1. Bucket every row by (kind, topLevel).
 *   2. Drop empty buckets.
 *   3. Rank by total churn (added + deleted) desc; lockfile + snapshots
 *      bubble to the BOTTOM regardless of churn because they're the
 *      "commit last so the real change ships first" buckets.
 *   4. Cap at 6 clusters (anything beyond is a sign the user should
 *      `git add -p` rather than batch-split).
 */
export function clusterDiffRows(args: ClusterArgs): DiffCluster[] {
  const { rows, preferredType, preferredScope } = args;
  if (!rows.length) return [];
  const map = new Map<string, DiffCluster>();
  for (const r of rows) {
    const kind = classifyPath(r.path);
    const top = topLevelOf(r.path);
    const key = `${kind}\u0000${top}`;
    let cluster = map.get(key);
    if (!cluster) {
      cluster = {
        kind,
        topLevel: top,
        paths: [],
        added: 0,
        deleted: 0,
        churn: 0,
        suggestedSubject: '',
      };
      map.set(key, cluster);
    }
    cluster.paths.push(r.path);
    cluster.added += r.added;
    cluster.deleted += r.deleted;
    cluster.churn += r.added + r.deleted;
  }
  const all = [...map.values()];
  for (const c of all) {
    c.paths.sort();
    c.suggestedSubject = buildSuggestedSubject(c, preferredType, preferredScope);
  }
  // Sort: lockfile + snapshots LAST, everything else by churn desc, with
  // alphabetical topLevel as a tiebreaker for deterministic ordering.
  all.sort((a, b) => {
    const aLow = a.kind === 'lockfile' || a.kind === 'snapshots';
    const bLow = b.kind === 'lockfile' || b.kind === 'snapshots';
    if (aLow !== bLow) return aLow ? 1 : -1;
    if (b.churn !== a.churn) return b.churn - a.churn;
    return a.topLevel.localeCompare(b.topLevel);
  });
  return all.slice(0, 6);
}

function buildSuggestedSubject(
  c: DiffCluster,
  preferredType: string | undefined,
  preferredScope: string | undefined,
): string {
  const scopePart = preferredScope ? `(${preferredScope})` : '';
  switch (c.kind) {
    case 'lockfile':
      return `chore(deps): bump lockfile`;
    case 'snapshots':
      return `test: refresh ${c.topLevel === '(repo root)' ? '' : c.topLevel + ' '}snapshots`.replace('  ', ' ').trim();
    case 'tests':
      return `test${scopePart}: ${c.topLevel === '(repo root)' ? 'add tests' : `update ${c.topLevel} tests`}`;
    case 'docs':
      return `docs${scopePart}: update`;
    case 'source':
      const type = preferredType || 'refactor';
      const focus = c.topLevel === '(repo root)' ? 'root changes' : `${c.topLevel} changes`;
      return `${type}${scopePart}: ${focus}`;
  }
}

/**
 * Build the git commands the view layer will run to apply a cluster
 * split. We never RUN these — we just compose the shape the user can
 * paste into a terminal. That keeps the destructive bit (rewriting the
 * stage) entirely under the user's control.
 *
 * For each cluster we emit:
 *
 *   git reset HEAD
 *   git add -- <path1> <path2> ...
 *   git commit -m "<subject>"
 *
 * The first command unstages EVERYTHING so each subsequent `add` only
 * stages the cluster's paths. The user runs this sequence in order;
 * if they want different cluster ordering they can rearrange before
 * running.
 */
export function buildSplitCommands(clusters: DiffCluster[]): string[] {
  if (!clusters.length) return [];
  const out: string[] = [];
  out.push('# Reset staging so we can rebuild it one cluster at a time');
  out.push('git reset HEAD');
  out.push('');
  for (const c of clusters) {
    const header = `# ${describeCluster(c)} (${c.paths.length} file${c.paths.length === 1 ? '' : 's'}, +${c.added}/-${c.deleted})`;
    out.push(header);
    // Use --pathspec-from-file when there are lots of paths; for now
    // inline them — the user wants to SEE the paths in the suggestion.
    const quoted = c.paths.map(p => quotePath(p)).join(' \\\n  ');
    out.push(`git add -- ${quoted}`);
    out.push(`git commit -m ${shellQuote(c.suggestedSubject)}`);
    out.push('');
  }
  return out;
}

function quotePath(p: string): string {
  // Paths with whitespace get quoted; everything else is bare. We use
  // POSIX-style single quotes; Windows users running this in PowerShell
  // would adapt as needed.
  if (/[\s'"\\$]/.test(p)) return shellQuote(p);
  return p;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function describeCluster(c: DiffCluster): string {
  const label = c.kind === 'lockfile' ? 'lockfile / generated'
    : c.kind === 'snapshots' ? 'snapshots'
    : c.kind === 'tests' ? 'tests'
    : c.kind === 'docs' ? 'docs'
    : 'source';
  const scope = c.topLevel === '(repo root)' ? '' : ` · ${c.topLevel}/`;
  return `${label}${scope}`;
}

/**
 * Summarise a cluster set into a single sentence for the picker header.
 */
export function summariseClusters(clusters: DiffCluster[]): string {
  if (!clusters.length) return 'No split suggestions.';
  const parts = clusters.map(c => describeCluster(c));
  return `${clusters.length} suggested commit${clusters.length === 1 ? '' : 's'}: ${parts.join(' \u2192 ')}`;
}
