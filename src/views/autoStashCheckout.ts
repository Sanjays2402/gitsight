/**
 * Auto-Stash Before Checkout (F48).
 *
 * Wraps the existing `gitsight.checkoutBranch` and any other checkout
 * surfaces in a graceful recovery flow:
 *
 *   1. Try `git checkout <target>` as normal.
 *   2. On failure, classify the stderr. If it's an autoStashable
 *      conflict (tracked-file overwrite), offer a "Stash & switch"
 *      prompt; on confirmation, derive a smart stash name (re-uses the
 *      F43 helpers), stash, retry the checkout, then offer to re-apply
 *      the stash after the switch lands.
 *   3. Any other failure (untracked overwrite, ambiguous ref, merge in
 *      progress) is surfaced to the user as-is — auto-stash doesn't fix
 *      those.
 *
 * Configurable via:
 *   gitsight.autoStash.enabled       (default true) — turn off to get
 *                                                      the raw error back
 *   gitsight.autoStash.autoApply     (default 'prompt') — 'always' / 'never'
 *                                                          / 'prompt' to
 *                                                          re-apply after
 *                                                          the switch
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { classifyCheckoutError, summariseBlock } from '../git/autoStash';
import { suggestStashNames, dirtyPaths } from '../git/stashNaming';

export type AutoStashOutcome =
  | 'switched-clean'        // checkout worked first try
  | 'switched-after-stash'  // we stashed and retried, the stash was kept
  | 'switched-and-popped'   // we stashed, retried, then popped
  | 'cancelled'             // user said no to auto-stash
  | 'failed';               // checkout still failed after the stash dance

/**
 * Try to check out `target`, falling back to a stash + retry when git
 * refuses with a local-changes blocker.
 *
 * Returns the outcome so the caller can refresh views or report it to
 * the user.
 */
export async function checkoutWithAutoStash(git: Git, target: string): Promise<AutoStashOutcome> {
  const cfg = vscode.workspace.getConfiguration('gitsight.autoStash');
  const enabled = cfg.get<boolean>('enabled', true);

  // First attempt.
  try {
    await git.raw(['checkout', target]);
    return 'switched-clean';
  } catch (e: any) {
    const stderr = e?.message ?? String(e);
    if (!enabled) {
      throw e; // user opted out — surface the raw failure
    }
    const block = classifyCheckoutError(stderr);
    if (!block || !block.autoStashable) {
      throw e; // not something stashing fixes
    }
    // Confirmed: local-changes conflict. Offer the rescue.
    return await rescueWithStash(git, target, block.files, cfg);
  }
}

async function rescueWithStash(
  git: Git,
  target: string,
  blockerFiles: string[],
  cfg: vscode.WorkspaceConfiguration,
): Promise<AutoStashOutcome> {
  // 1. Decide on a name. The dirty path list from git status is the
  //    canonical one — fall back to the blocker list if status fails.
  let dirty = blockerFiles;
  try {
    const porcelain = await git.raw(['status', '--porcelain=v1']);
    const fromStatus = dirtyPaths(porcelain);
    if (fromStatus.length) dirty = fromStatus;
  } catch {
    // keep blockerFiles
  }
  const branchNow = await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const repoName = git.cwd.split('/').pop();
  const suggestions = suggestStashNames({
    branch: branchNow,
    dirtyPaths: dirty,
    activeFile: vscode.window.activeTextEditor?.document.uri.fsPath,
    repoName,
  });
  const defaultName = suggestions[0]?.name ?? 'auto-stash-wip';

  // 2. Ask once. Modal, default Stash & switch.
  const summary = summariseBlock({ reason: 'local-changes', files: blockerFiles, autoStashable: true });
  const choice = await vscode.window.showWarningMessage(
    `GitSight: cannot switch to '${target}' — ${summary}.`,
    {
      modal: true,
      detail: `Stash your changes as "${defaultName}" and switch to '${target}'? You'll be offered to re-apply the stash after the switch.`,
    },
    'Stash & switch',
    'Pick stash name…',
  );
  if (!choice) return 'cancelled';

  let stashName = defaultName;
  if (choice === 'Pick stash name…') {
    const picked = await pickStashName(suggestions, defaultName);
    if (!picked) return 'cancelled';
    stashName = picked;
  }

  // 3. Stash.
  try {
    await git.raw(['stash', 'push', '-u', '-m', stashName]);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: stash failed: ${e.message ?? e}`);
    return 'failed';
  }

  // 4. Retry the checkout.
  try {
    await git.raw(['checkout', target]);
  } catch (e: any) {
    // Worst-case: the checkout still fails. Try to pop the stash back so
    // the user isn't left in a confused state.
    await safe(git, ['stash', 'pop']);
    vscode.window.showErrorMessage(`GitSight: switch to '${target}' still failed after stash: ${e.message ?? e}`);
    return 'failed';
  }

  // 5. Decide whether to re-apply.
  const autoApply = cfg.get<string>('autoApply', 'prompt');
  if (autoApply === 'never') {
    vscode.window.showInformationMessage(
      `GitSight: switched to '${target}'. Stash "${stashName}" kept — run \`git stash pop\` when ready.`,
    );
    return 'switched-after-stash';
  }
  if (autoApply === 'always') {
    return await tryPop(git, target, stashName);
  }
  // Prompt mode (default).
  const action = await vscode.window.showInformationMessage(
    `GitSight: switched to '${target}'. Apply stash "${stashName}" here?`,
    'Pop',
    'Apply (keep)',
    'Leave stashed',
  );
  if (action === 'Pop') return await tryPop(git, target, stashName);
  if (action === 'Apply (keep)') return await tryApply(git, target, stashName);
  return 'switched-after-stash';
}

async function tryPop(git: Git, target: string, stashName: string): Promise<AutoStashOutcome> {
  try {
    await git.raw(['stash', 'pop']);
    vscode.window.setStatusBarMessage(`GitSight: switched to '${target}', stash "${stashName}" popped.`, 4000);
    return 'switched-and-popped';
  } catch (e: any) {
    vscode.window.showWarningMessage(
      `GitSight: switched to '${target}', but stash pop hit conflicts: ${e.message ?? e}. Stash kept; resolve and run \`git stash drop\`.`,
    );
    return 'switched-after-stash';
  }
}

async function tryApply(git: Git, target: string, stashName: string): Promise<AutoStashOutcome> {
  try {
    await git.raw(['stash', 'apply']);
    vscode.window.setStatusBarMessage(`GitSight: switched to '${target}', stash "${stashName}" applied (still in list).`, 4000);
    return 'switched-after-stash';
  } catch (e: any) {
    vscode.window.showWarningMessage(
      `GitSight: switched to '${target}', but stash apply hit conflicts: ${e.message ?? e}. Stash kept.`,
    );
    return 'switched-after-stash';
  }
}

async function pickStashName(
  suggestions: { name: string; source: string }[],
  defaultName: string,
): Promise<string | undefined> {
  type Pk = vscode.QuickPickItem & { _name: string };
  const items: Pk[] = suggestions.slice(0, 8).map(s => ({
    label: `$(archive) ${s.name}`,
    description: s.source,
    _name: s.name,
  }));
  items.push({
    label: '$(edit) Type a custom name…',
    description: '',
    _name: '__custom__',
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Stash name (default: ${defaultName})`,
  });
  if (!picked) return undefined;
  if (picked._name !== '__custom__') return picked._name;
  return await vscode.window.showInputBox({
    prompt: 'Stash name',
    value: defaultName,
  });
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return (await git.raw(args)).trim(); } catch { return ''; }
}
