/**
 * F109 - Stash-on-Pull Guard.
 *
 * Wraps `gitsight.pull` so a "your local changes would be overwritten"
 * failure becomes a guided "Stash, pull, re-apply" flow rather than a
 * raw stderr toast.
 *
 * Composes with:
 *   - F43 stashSaveSmart (naming convention -- we suffix `-prepull`)
 *   - F48 autoStash (the checkout cousin -- same classifier shape)
 *   - F80 stashOnSwitch (the post-checkout re-apply UX)
 *
 * Wired from extension.ts: gitsight.pull now calls `runGuardedPull(git)`
 * instead of `git.pull()` directly. The guard:
 *
 *   1. Tries the pull.
 *   2. On failure, classifies the stderr via classifyPullError().
 *   3. For auto-stashable failures, shows a single info modal:
 *        "GitSight: pull blocked -- 3 files would be overwritten."
 *        [Stash, pull, re-apply] [Show stash plan] [Cancel]
 *   4. Stashes with a smart prepull name, retries the pull, then
 *      pops. Reports per-step outcome with a status-bar message.
 *   5. If the pop creates conflict markers, surfaces a warning toast
 *      with the stash ref so the user knows where their work lives.
 *
 * Non-auto-stashable failures (untracked overwrite, merge/rebase in
 * progress, no upstream) get a one-shot info toast pointing to the
 * right fix; we don't pretend we can recover from those.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import {
  classifyPullError,
  suggestPrepullStashName,
  summarisePullBlock,
  pullBlockHeadline,
  summariseRecovery,
  RecoveryResult,
  PullBlock,
} from '../git/stashOnPull';

const pexec = promisify(execFile);

export type GuardedPullResult =
  | { kind: 'ok' }
  | { kind: 'recovered'; recovery: RecoveryResult }
  | { kind: 'rejected'; block: PullBlock; raw: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string };

/**
 * Public entry point. Always returns -- never throws.
 *
 * Caller (extension.ts gitsight.pull) wraps in errorWrap so any unhandled
 * exception still hits the user as a toast.
 */
export async function runGuardedPull(git: Git): Promise<GuardedPullResult> {
  const cfg = vscode.workspace.getConfiguration('gitsight.stashOnPull');
  if (!cfg.get<boolean>('enabled', true)) {
    try { await git.pull(); return { kind: 'ok' }; }
    catch (e: any) { return { kind: 'failed', error: e?.message ?? String(e) }; }
  }

  // 1. Attempt the pull.
  try {
    await git.pull();
    return { kind: 'ok' };
  } catch (e: any) {
    const raw = e?.message ?? String(e);
    const block = classifyPullError(raw);
    if (!block) {
      vscode.window.showErrorMessage(`GitSight: ${raw.split('\n')[0]}`);
      return { kind: 'failed', error: raw };
    }

    // Non-auto-stashable: surface a tailored hint, don't try to recover.
    if (!block.autoStashable) {
      vscode.window.showWarningMessage(`${pullBlockHeadline(block)} ${summarisePullBlock(block)}`);
      return { kind: 'rejected', block, raw };
    }

    // Auto-stashable: offer the recovery.
    const headline = pullBlockHeadline(block);
    const summary = summarisePullBlock(block);
    const decision = await vscode.window.showInformationMessage(
      `${headline}\n\n${summary}`,
      { modal: true },
      'Stash, pull, re-apply',
      'Show stash plan',
    );
    if (!decision) return { kind: 'cancelled' };

    if (decision === 'Show stash plan') {
      const branch = await safeBranch(git);
      const dirty = block.files;
      const name = suggestPrepullStashName(branch, dirty);
      const lines = [
        '# GitSight: pull guard plan',
        '',
        `Branch: \`${branch}\``,
        `Stash name: \`${name}\``,
        `Files (${dirty.length}): ${dirty.length ? dirty.map(f => '\`' + f + '\`').join(', ') : '(rebase blocked the index -- no file list)'}`,
        '',
        '## Steps',
        '1. `git stash push -m "' + name + '"`',
        '2. `git pull`',
        '3. `git stash pop`',
        '',
        '## Notes',
        '- If step 3 creates conflicts, your work is preserved in the stash.',
        '  Resolve in-editor, then `git stash drop` to remove the stash.',
        '- If the pull fails (network, etc.), your stash is intact -- run',
        '  `git stash pop` to restore.',
      ];
      const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
      return { kind: 'cancelled' };
    }

    return await runRecovery(git, block);
  }
}

async function runRecovery(git: Git, block: PullBlock): Promise<GuardedPullResult> {
  const branch = await safeBranch(git);
  const name = suggestPrepullStashName(branch, block.files);
  const result: RecoveryResult = { steps: [], fullySuccessful: false };

  // STEP 1 -- stash.
  let stashRef: string | undefined;
  try {
    // -u is intentionally OFF: we only want to stash tracked changes.
    // Untracked overwrite would have been caught earlier as a non-
    // auto-stashable failure.
    await git.raw(['stash', 'push', '-m', name]);
    // git stash push doesn't print the new ref, but the most recent is
    // always stash@{0}. We capture the actual ref so the result message
    // can point to it even after subsequent stashes happen elsewhere.
    stashRef = await captureLatestStashRef(git);
    result.stashRef = stashRef;
    result.steps.push({ step: 'stash', outcome: 'ok', detail: stashRef });
  } catch (e: any) {
    result.steps.push({ step: 'stash', outcome: 'fail', detail: short(e?.message ?? String(e)) });
    vscode.window.showErrorMessage(`GitSight: pre-pull stash failed -- ${result.steps[0].detail}`);
    return { kind: 'recovered', recovery: result };
  }

  // STEP 2 -- pull.
  try {
    await git.pull();
    result.steps.push({ step: 'pull', outcome: 'ok' });
  } catch (e: any) {
    const detail = short(e?.message ?? String(e));
    result.steps.push({ step: 'pull', outcome: 'fail', detail });
    vscode.window.showErrorMessage(`GitSight: pull failed AFTER stashing -- your work is safe in ${stashRef ?? 'stash@{0}'}. ${detail}`);
    return { kind: 'recovered', recovery: result };
  }

  // STEP 3 -- pop. Conflict markers are NOT the same as a failed pop --
  // git returns non-zero with "CONFLICT" in stdout, but the stash is
  // still on disk for the user to clean up.
  try {
    await git.raw(['stash', 'pop']);
    result.steps.push({ step: 'pop', outcome: 'ok' });
    result.fullySuccessful = true;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (/CONFLICT/.test(msg) || /Merge conflict/.test(msg)) {
      result.steps.push({ step: 'pop', outcome: 'conflict', detail: 'merge conflicts in pop' });
      vscode.window.showWarningMessage(
        `GitSight: pulled, but stash re-apply produced conflicts. Your work is in ${stashRef ?? 'stash@{0}'}. ` +
        `Resolve conflicts, then \`git stash drop ${stashRef ?? 'stash@{0}'}\` to clean up.`,
      );
      return { kind: 'recovered', recovery: result };
    }
    result.steps.push({ step: 'pop', outcome: 'fail', detail: short(msg) });
    vscode.window.showErrorMessage(`GitSight: stash pop failed -- ${stashRef ?? 'stash@{0}'} still exists. ${short(msg)}`);
    return { kind: 'recovered', recovery: result };
  }

  vscode.window.setStatusBarMessage(summariseRecovery(result), 5000);
  return { kind: 'recovered', recovery: result };
}

async function safeBranch(git: Git): Promise<string> {
  try { return (await git.currentBranch()) || ''; } catch { return ''; }
}

async function captureLatestStashRef(git: Git): Promise<string | undefined> {
  try {
    const out = await git.raw(['stash', 'list', '-n1', '--format=%gd']);
    const first = out.split('\n').map(l => l.trim()).find(Boolean);
    return first || 'stash@{0}';
  } catch { return 'stash@{0}'; }
}

function short(s: string): string {
  const line = s.split('\n').map(l => l.trim()).find(Boolean) || s;
  return line.length > 200 ? line.slice(0, 197) + '\u2026' : line;
}

// Re-export for tests / callers that just want to query without running.
export { classifyPullError, pullBlockHeadline, summarisePullBlock };
