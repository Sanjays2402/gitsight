/**
 * Pure helpers for the Auto-Stash-Before-Checkout flow (F48).
 *
 * `git checkout <branch>` refuses to switch when the worktree has local
 * changes that would be overwritten by the switch. The error looks like:
 *
 *   error: Your local changes to the following files would be overwritten by checkout:
 *           src/auth.ts
 *           src/test.ts
 *   Please commit your changes or stash them before you switch branches.
 *
 * This module:
 *
 *   1. Recognises that specific error shape so the controller knows to
 *      offer "Stash & switch" instead of just showing the raw error.
 *   2. Parses the list of conflicting files for the dialog body and for
 *      the smart-stash naming step (which uses dirty paths to pick a
 *      sensible name).
 *
 * The detection is conservative: we ONLY treat the message as a
 * stashable conflict when the recognisable header phrase appears.
 * Other checkout failures (no such branch, ambiguous ref, dirty worktree
 * + untracked overwrite) are surfaced to the user as-is.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/autoStash.test.ts.
 */

export type CheckoutBlockReason =
  | 'local-changes'   // tracked files would be overwritten — auto-stash fixes
  | 'untracked'       // untracked files would be overwritten — auto-stash does NOT fix
  | 'merge-in-progress'
  | 'rebase-in-progress'
  | 'other';

export interface CheckoutBlock {
  reason: CheckoutBlockReason;
  /** Files git named as the blockers. Empty for non-file reasons. */
  files: string[];
  /** True only when an auto-stash + retry-checkout would unblock the switch. */
  autoStashable: boolean;
}

/**
 * Recognise a `git checkout` error message. Returns undefined when we
 * cannot identify the failure (caller should surface the raw error).
 */
export function classifyCheckoutError(stderr: string): CheckoutBlock | undefined {
  const s = (stderr ?? '').trim();
  if (!s) return undefined;

  if (LOCAL_CHANGES_RE.test(s)) {
    return {
      reason: 'local-changes',
      files: extractFileList(s, LOCAL_CHANGES_FILES_RE),
      autoStashable: true,
    };
  }
  if (UNTRACKED_RE.test(s)) {
    return {
      reason: 'untracked',
      files: extractFileList(s, UNTRACKED_FILES_RE),
      autoStashable: false,
    };
  }
  if (/rebase in progress|cannot switch.*rebase/i.test(s)) {
    return { reason: 'rebase-in-progress', files: [], autoStashable: false };
  }
  if (/merge in progress|cannot switch.*merge/i.test(s)) {
    return { reason: 'merge-in-progress', files: [], autoStashable: false };
  }
  return { reason: 'other', files: [], autoStashable: false };
}

// "Your local changes to the following files would be overwritten by checkout"
// (sometimes "merge", "switch", "rebase" — all share the phrasing). Anchor on
// the distinctive sentence so we don't false-match prose.
const LOCAL_CHANGES_RE = /Your local changes to the following files would be overwritten by (?:checkout|switch|merge|rebase)/i;
const LOCAL_CHANGES_FILES_RE = /Your local changes to the following files would be overwritten by [^\n]+:\n([\s\S]*?)(?:\nPlease commit|\nAborting|\nerror:|\n$|$)/i;

const UNTRACKED_RE = /The following untracked working tree files would be (?:overwritten by checkout|overwritten by merge|removed)/i;
const UNTRACKED_FILES_RE = /The following untracked working tree files would be [^\n]+:\n([\s\S]*?)(?:\nPlease move|\nAborting|\nerror:|\n$|$)/i;

function extractFileList(s: string, re: RegExp): string[] {
  const m = re.exec(s);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map(l => l.replace(/^\s+/, '').trim())
    .filter(Boolean)
    // Some git versions print "hint: " lines mixed in — filter them.
    .filter(l => !/^hint:/i.test(l));
}

/**
 * Build a one-line summary suitable for a dialog body or status message:
 *
 *   3 tracked files would be overwritten (src/auth.ts, src/test.ts, …)
 *
 * Caps the file list at `maxShown` to keep the dialog text bounded.
 */
export function summariseBlock(b: CheckoutBlock, maxShown = 3): string {
  switch (b.reason) {
    case 'local-changes': {
      if (!b.files.length) return 'tracked files would be overwritten';
      const head = b.files.slice(0, maxShown).join(', ');
      const more = b.files.length > maxShown ? `, +${b.files.length - maxShown}` : '';
      return `${b.files.length} tracked file${b.files.length === 1 ? '' : 's'} (${head}${more})`;
    }
    case 'untracked':
      return `${b.files.length} untracked file${b.files.length === 1 ? '' : 's'} (cannot auto-stash)`;
    case 'merge-in-progress':
      return 'merge in progress — finish or abort the merge first';
    case 'rebase-in-progress':
      return 'rebase in progress — finish or abort the rebase first';
    case 'other':
      return 'checkout was rejected';
  }
}

/** Convenience constructor used by tests. */
export function makeBlock(reason: CheckoutBlockReason, files: string[] = []): CheckoutBlock {
  return {
    reason,
    files,
    autoStashable: reason === 'local-changes',
  };
}
