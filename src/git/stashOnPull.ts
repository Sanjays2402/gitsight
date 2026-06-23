/**
 * Pure helpers for the Stash-on-Pull Guard (F109).
 *
 * `git pull` refuses to merge / rebase when the worktree has local
 * changes that would be overwritten by the incoming refs. The error
 * shape mirrors the F48 auto-stash-checkout one:
 *
 *   error: Your local changes to the following files would be overwritten by merge:
 *           src/auth.ts
 *           src/index.ts
 *   Please commit your changes or stash them before you merge.
 *
 *   error: cannot pull with rebase: You have unstaged changes.
 *
 *   error: Cannot rebase: Your index contains uncommitted changes.
 *
 * This module classifies the failure so the controller can offer a
 * "Stash, pull, re-apply" recovery instead of the raw error.
 *
 * The recovery shape is:
 *   1. git stash push -m "<smart name>"   (composes with F43 naming)
 *   2. git pull
 *   3. git stash pop  (returning conflict markers if any -- caller surfaces)
 *
 * Unlike F48 (auto-stash on checkout), this distinguishes BETWEEN merge
 * vs rebase failures because the error phrasing differs. Both are
 * recoverable via stash; we just route the user to the right verb.
 *
 * Pure -- no vscode, no child_process. Tests in
 * test/git/stashOnPull.test.ts.
 */

export type PullBlockReason =
  | 'merge-local-changes'    // pull --merge would clobber tracked files
  | 'rebase-local-changes'   // pull --rebase has unstaged or staged changes
  | 'untracked-overwrite'    // untracked files would be overwritten -- NOT auto-stashable
  | 'merge-in-progress'      // existing merge stuck mid-resolution
  | 'rebase-in-progress'     // existing rebase stuck mid-resolution
  | 'no-tracking'            // current branch has no upstream
  | 'other';

export interface PullBlock {
  reason: PullBlockReason;
  files: string[];
  /** True when an auto-stash + pull + pop would unblock the user. */
  autoStashable: boolean;
}

const MERGE_LOCAL_RE = /Your local changes to the following files would be overwritten by merge/i;
const MERGE_LOCAL_FILES_RE = /Your local changes to the following files would be overwritten by merge:\n([\s\S]*?)(?:\nPlease commit|\nAborting|\nerror:|\n$|$)/i;

// `git pull --rebase` short-circuits BEFORE touching files when the index
// or worktree has anything dirty -- the error phrasing is different from
// the merge case and the file list is NOT included.
const REBASE_LOCAL_RE = /cannot pull with rebase: You have unstaged changes/i;
const REBASE_INDEX_RE = /Cannot rebase: Your index contains uncommitted changes/i;

const UNTRACKED_RE = /The following untracked working tree files would be overwritten by merge/i;
const UNTRACKED_FILES_RE = /The following untracked working tree files would be overwritten by merge:\n([\s\S]*?)(?:\nPlease move|\nAborting|\nerror:|\n$|$)/i;

const NO_TRACKING_RE = /There is no tracking information for the current branch/i;
const MERGE_IN_PROGRESS_RE = /You have not concluded your merge|MERGE_HEAD exists|merge in progress/i;
const REBASE_IN_PROGRESS_RE = /rebase in progress/i;

export function classifyPullError(stderr: string): PullBlock | undefined {
  const s = (stderr ?? '').trim();
  if (!s) return undefined;
  if (NO_TRACKING_RE.test(s)) {
    return { reason: 'no-tracking', files: [], autoStashable: false };
  }
  if (REBASE_IN_PROGRESS_RE.test(s)) {
    return { reason: 'rebase-in-progress', files: [], autoStashable: false };
  }
  if (MERGE_IN_PROGRESS_RE.test(s)) {
    return { reason: 'merge-in-progress', files: [], autoStashable: false };
  }
  if (UNTRACKED_RE.test(s)) {
    return {
      reason: 'untracked-overwrite',
      files: extractFileList(s, UNTRACKED_FILES_RE),
      autoStashable: false,
    };
  }
  if (MERGE_LOCAL_RE.test(s)) {
    return {
      reason: 'merge-local-changes',
      files: extractFileList(s, MERGE_LOCAL_FILES_RE),
      autoStashable: true,
    };
  }
  if (REBASE_LOCAL_RE.test(s) || REBASE_INDEX_RE.test(s)) {
    return {
      reason: 'rebase-local-changes',
      files: [],
      autoStashable: true,
    };
  }
  return { reason: 'other', files: [], autoStashable: false };
}

function extractFileList(s: string, re: RegExp): string[] {
  const m = re.exec(s);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map(l => l.replace(/^\s+/, '').trim())
    .filter(Boolean)
    .filter(l => !/^hint:/i.test(l));
}

/**
 * Build a stash-name suggestion for the recovery path. Reuses the F43
 * branch+kebab convention but always appends `-prepull` so post-recovery
 * the stash is greppable as "made by the pull guard".
 *
 *   feature/auth + ['src/auth.ts', 'src/login.ts']  -> 'auth-auth-prepull'
 *   main + dirty []                                  -> 'main-prepull'
 *
 * Conservative ~40-char cap to match git's stash subject conventions.
 */
export function suggestPrepullStashName(branch: string, dirtyPaths: string[]): string {
  const branchPart = kebab(stripBranchPrefix(branch));
  if (!branchPart) {
    if (!dirtyPaths.length) return 'prepull';
    const base = dirtyPaths[0].split('/').pop() || '';
    return kebab(base.replace(/\.[^.]+$/, '')) + '-prepull';
  }
  if (!dirtyPaths.length) return cap(`${branchPart}-prepull`);
  const top = topLevelDir(dirtyPaths);
  if (top) return cap(`${branchPart}-${kebab(top)}-prepull`);
  return cap(`${branchPart}-prepull`);
}

function stripBranchPrefix(b: string): string {
  if (!b) return '';
  return b.replace(/^(feature|feat|fix|bug|bugfix|chore|hotfix|release)\//i, '').split('/').pop() || b;
}

function kebab(s: string): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function cap(s: string): string {
  return s.length > 40 ? s.slice(0, 40).replace(/-+$/, '') : s;
}

/** Most common top-level directory among an array of repo-relative paths. */
function topLevelDir(paths: string[]): string {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const seg = p.split('/').filter(Boolean);
    if (seg.length < 2) continue;
    // Strip a leading src/lib/app the same way commitScaffold does.
    let i = 0;
    const skip = new Set(['src', 'lib', 'app', 'packages']);
    while (i < seg.length && skip.has(seg[i].toLowerCase())) i++;
    if (i >= seg.length) continue;
    counts.set(seg[i], (counts.get(seg[i]) ?? 0) + 1);
  }
  if (!counts.size) return '';
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/**
 * One-line summary suitable for a dialog body or status message.
 *
 *   "3 tracked files would be overwritten by merge (src/auth.ts, +2)"
 */
export function summarisePullBlock(b: PullBlock, maxShown = 3): string {
  switch (b.reason) {
    case 'merge-local-changes': {
      if (!b.files.length) return 'tracked files would be overwritten by merge';
      const head = b.files.slice(0, maxShown).join(', ');
      const more = b.files.length > maxShown ? `, +${b.files.length - maxShown}` : '';
      return `${b.files.length} tracked file${b.files.length === 1 ? '' : 's'} (${head}${more})`;
    }
    case 'rebase-local-changes':
      return 'rebase blocked by unstaged or uncommitted changes';
    case 'untracked-overwrite':
      return `${b.files.length} untracked file${b.files.length === 1 ? '' : 's'} (cannot auto-stash)`;
    case 'merge-in-progress':
      return 'merge in progress -- finish or abort the merge first';
    case 'rebase-in-progress':
      return 'rebase in progress -- finish or abort the rebase first';
    case 'no-tracking':
      return 'current branch has no upstream -- set one with `git branch -u origin/<name>`';
    case 'other':
      return 'pull was rejected';
  }
}

/**
 * Title for the recovery toast / modal.
 *
 *   "GitSight: pull blocked -- 3 files would be overwritten."
 *   "GitSight: pull --rebase blocked -- you have unstaged changes."
 */
export function pullBlockHeadline(b: PullBlock): string {
  switch (b.reason) {
    case 'merge-local-changes':
      return `GitSight: pull blocked -- ${b.files.length || 'some'} tracked file${b.files.length === 1 ? '' : 's'} would be overwritten.`;
    case 'rebase-local-changes':
      return 'GitSight: pull --rebase blocked -- you have unstaged or uncommitted changes.';
    case 'untracked-overwrite':
      return `GitSight: pull blocked -- ${b.files.length || 'some'} untracked file${b.files.length === 1 ? '' : 's'} would be overwritten.`;
    case 'merge-in-progress':
      return 'GitSight: pull blocked -- existing merge in progress.';
    case 'rebase-in-progress':
      return 'GitSight: pull blocked -- existing rebase in progress.';
    case 'no-tracking':
      return 'GitSight: pull blocked -- current branch has no upstream.';
    case 'other':
      return 'GitSight: pull was rejected by git.';
  }
}

/**
 * Recovery plan outcome -- used by the controller to summarise the
 * stash + pull + pop chain after the fact.
 */
export type RecoveryStep = 'stash' | 'pull' | 'pop';
export type StepOutcome = 'ok' | 'fail' | 'conflict';

export interface RecoveryResult {
  steps: { step: RecoveryStep; outcome: StepOutcome; detail?: string }[];
  /** The stash ref created during the recovery (if any), so the caller
   *  can hand it back to the user when pop fails ("your work is in <ref>"). */
  stashRef?: string;
  /** True when stash + pull + pop all returned 'ok'. */
  fullySuccessful: boolean;
}

/** Build a one-line summary of the recovery outcome for a status message. */
export function summariseRecovery(r: RecoveryResult): string {
  if (r.fullySuccessful) return 'GitSight: stashed, pulled, re-applied -- clean.';
  const popStep = r.steps.find(s => s.step === 'pop');
  if (popStep?.outcome === 'conflict') {
    return `GitSight: pulled, but stash re-apply created conflicts. Resolve them, then drop ${r.stashRef ?? 'the stash'}.`;
  }
  const failed = r.steps.find(s => s.outcome === 'fail');
  if (failed) {
    return `GitSight: recovery failed at ${failed.step} (${failed.detail ?? 'unknown'}). Stash: ${r.stashRef ?? 'not created'}.`;
  }
  return 'GitSight: recovery completed with warnings.';
}
