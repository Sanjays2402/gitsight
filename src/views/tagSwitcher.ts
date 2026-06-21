/**
 * Tag Quick-Switcher (F16) — semver-sorted tag picker with detached-HEAD safety.
 *
 * Tags by definition don't point at a branch — checking one out detaches HEAD,
 * which is fine for inspection but easy to lose work on. So this picker:
 *
 *   1. Lists tags sorted by semver (newest first), falling back to date for
 *      non-semver names. Pre-release tags are visually de-emphasised.
 *   2. Confirms before detaching HEAD, surfacing the current branch so the
 *      user knows what they're leaving behind.
 *   3. Offers a one-step "Create branch from this tag" escape hatch in the same
 *      flow when the user doesn't want a detached HEAD.
 *
 * Pure ranking + parsing lives in src/git/tagSort.ts (unit-tested).
 */
import * as vscode from 'vscode';
import { Git, Tag } from '../git/git';
import { timeAgo } from '../git/format';
import { sortTagsForPicker, describeTag } from '../git/tagSort';

type Action = 'checkout' | 'branch-from' | 'copy-sha';

interface PickerItem extends vscode.QuickPickItem {
  _tag?: Tag;
  _action?: Action;
}

export async function showTagQuickSwitcher(git: Git): Promise<void> {
  const all = await git.tags();
  if (!all.length) {
    vscode.window.showInformationMessage('GitSight: no tags found.');
    return;
  }
  const sorted = sortTagsForPicker(all);
  const items: PickerItem[] = sorted.map(t => {
    const d = describeTag(t, 64);
    const bits: string[] = [];
    if (d.isPre) bits.push('pre-release');
    if (d.date) bits.push(d.date);
    if (t.date) bits.push(timeAgo(t.date));
    bits.push(t.sha.slice(0, 7));
    const icon = d.isPre ? '$(beaker)' : '$(tag)';
    return {
      label: `${icon} ${t.name}`,
      description: bits.join('  ·  '),
      detail: d.subject,
      _tag: t,
    };
  });

  const qp = vscode.window.createQuickPick<PickerItem>();
  qp.items = items;
  qp.placeholder = 'Pick a tag — checkout will detach HEAD';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.title = 'GitSight: Switch to Tag';

  const picked = await new Promise<PickerItem | undefined>(resolve => {
    qp.onDidAccept(() => { resolve(qp.selectedItems[0]); qp.hide(); });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!picked?._tag) return;

  await handleTagPick(git, picked._tag);
}

async function handleTagPick(git: Git, tag: Tag): Promise<void> {
  const current = await git.currentBranch().catch(() => '');
  type ActionItem = vscode.QuickPickItem & { _action: Action };
  const actions: ActionItem[] = [
    {
      label: '$(git-commit) Checkout (detached HEAD)',
      detail: current
        ? `Leaves '${current}' for a detached HEAD at ${tag.sha.slice(0, 7)}. Safe for inspection.`
        : `Detached HEAD at ${tag.sha.slice(0, 7)}.`,
      _action: 'checkout',
    },
    {
      label: '$(git-branch) Create branch from this tag\u2026',
      detail: `Make a new branch starting at ${tag.name} and check it out`,
      _action: 'branch-from',
    },
    {
      label: '$(clippy) Copy tag SHA',
      detail: tag.sha,
      _action: 'copy-sha',
    },
  ];
  const choice = await vscode.window.showQuickPick(actions, {
    placeHolder: `Tag ${tag.name} — pick an action`,
    matchOnDetail: true,
  });
  if (!choice) return;
  switch (choice._action) {
    case 'checkout': await checkoutDetached(git, tag); break;
    case 'branch-from': await branchFromTag(git, tag); break;
    case 'copy-sha':
      await vscode.env.clipboard.writeText(tag.sha);
      vscode.window.setStatusBarMessage(`Copied ${tag.sha.slice(0, 7)}`, 2000);
      break;
  }
}

async function checkoutDetached(git: Git, tag: Tag): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: checking out ${tag.name}…` },
    async () => {
      try {
        // Force the detached form so we don't accidentally create a local branch named the tag.
        await git.raw(['checkout', '--detach', tag.name]);
        vscode.window.setStatusBarMessage(`Detached HEAD at ${tag.name} (${tag.sha.slice(0, 7)})`, 3500);
        vscode.commands.executeCommand('gitsight.refresh');
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: ${e.message}`);
      }
    },
  );
}

async function branchFromTag(git: Git, tag: Tag): Promise<void> {
  const suggested = sanitiseBranchName(`tag/${tag.name}`);
  const existing = new Set((await git.branches(false)).map(b => b.name));
  const name = await vscode.window.showInputBox({
    prompt: `New branch name (from tag ${tag.name})`,
    value: suggested,
    validateInput: v => {
      const trimmed = v.trim();
      if (!trimmed) return 'Required';
      if (existing.has(trimmed)) return 'Branch already exists';
      if (!/^[^\s~^:?*\[\]\\]+$/.test(trimmed)) return 'Invalid branch name';
      return undefined;
    },
  });
  if (!name) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: branching from ${tag.name}…` },
    async () => {
      try {
        await git.createBranch(name.trim(), tag.name);
        await git.checkout(name.trim());
        vscode.window.setStatusBarMessage(`Switched to ${name.trim()} (from ${tag.name})`, 3000);
        vscode.commands.executeCommand('gitsight.refresh');
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: ${e.message}`);
      }
    },
  );
}

function sanitiseBranchName(s: string): string {
  return s.replace(/[\s~^:?*\[\]\\]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
