/**
 * Stash Quick-Switcher (F31) — Cmd+Shift+J keyboard-first picker over stashes,
 * with a follow-up action menu for the picked stash.
 *
 * Motivation: the built-in Stashes tree view requires three clicks. Engineers
 * stash 5+ times a day during big rebases / refactors and need a single-keystroke
 * way to "show me what I shelved most recently and let me pop/apply it".
 *
 * Flow:
 *
 *   1. List stashes sorted by `sortStashesForPicker` (newest-first, named beats
 *      WIP on ties). Each row shows the cleaned subject, the source branch in
 *      the description, and the stash ref + age in the detail.
 *   2. On pick, open a 4-action menu: Pop / Apply (keep stash) / Show diff /
 *      Drop. Pop and Drop confirm before destroying state.
 *   3. Refresh GitSight + the built-in SCM view after any mutation so trees,
 *      pills, and the Stashes view all reflect the new state instantly.
 *
 * The pure ranking + label helpers live in src/git/stashSort.ts and are unit-tested.
 */
import * as vscode from 'vscode';
import { Git, Stash } from '../git/git';
import { timeAgo } from '../git/format';
import {
  sortStashesForPicker,
  cleanStashSubject,
  describeStash,
} from '../git/stashSort';

type Action = 'pop' | 'apply' | 'show' | 'drop';

interface StashItem extends vscode.QuickPickItem {
  _stash: Stash;
}

interface ActionItem extends vscode.QuickPickItem {
  _action: Action;
}

export async function showStashQuickSwitcher(git: Git): Promise<void> {
  const all = await git.stashes();
  if (!all.length) {
    vscode.window.showInformationMessage('GitSight: no stashes to switch to.');
    return;
  }
  const sorted = sortStashesForPicker(all);

  const items: StashItem[] = sorted.map(s => {
    const d = describeStash(s);
    const subject = cleanStashSubject(s.subject) || '(empty)';
    const descBits: string[] = [];
    if (d.branch) descBits.push(d.branch);
    if (s.date && !Number.isNaN(s.date.getTime())) descBits.push(timeAgo(s.date));
    const icon = d.isNamed ? '$(bookmark)' : '$(archive)';
    return {
      label: `${icon} ${subject}`,
      description: descBits.join('  ·  '),
      detail: `${s.ref}${d.date ? '  ·  ' + d.date : ''}`,
      _stash: s,
    };
  });

  const qp = vscode.window.createQuickPick<StashItem>();
  qp.items = items;
  qp.placeholder = 'Pick a stash — applies to your current branch';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.title = 'GitSight: Switch Stash';

  const picked = await new Promise<StashItem | undefined>(resolve => {
    qp.onDidAccept(() => { resolve(qp.selectedItems[0]); qp.hide(); });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!picked) return;

  await handleStashPick(git, picked._stash);
}

async function handleStashPick(git: Git, stash: Stash): Promise<void> {
  const subject = cleanStashSubject(stash.subject) || stash.ref;
  const actions: ActionItem[] = [
    {
      label: '$(arrow-down) Pop',
      detail: 'Apply this stash to the working tree, then drop it from the reflog',
      _action: 'pop',
    },
    {
      label: '$(repo-pull) Apply (keep stash)',
      detail: 'Apply to the working tree but keep the stash for later',
      _action: 'apply',
    },
    {
      label: '$(diff) Show diff',
      detail: 'Open the stash as a unified diff in a new editor (read-only)',
      _action: 'show',
    },
    {
      label: '$(trash) Drop',
      detail: 'Permanently remove this stash from the reflog (no undo)',
      _action: 'drop',
    },
  ];
  const choice = await vscode.window.showQuickPick(actions, {
    placeHolder: `${stash.ref} — ${subject}`,
    matchOnDetail: true,
  });
  if (!choice) return;
  switch (choice._action) {
    case 'pop': await popStash(git, stash); break;
    case 'apply': await applyStash(git, stash); break;
    case 'show': await showStashDiff(git, stash); break;
    case 'drop': await dropStash(git, stash); break;
  }
}

async function popStash(git: Git, stash: Stash): Promise<void> {
  const ok = await vscode.window.showWarningMessage(
    `Pop ${stash.ref}? This applies it and removes it from the reflog.`,
    { modal: true },
    'Pop',
  );
  if (ok !== 'Pop') return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: pop ${stash.ref}` },
    async () => {
      try {
        await git.stashPop(stash.ref);
        vscode.window.setStatusBarMessage(`Popped ${stash.ref}`, 3000);
        vscode.commands.executeCommand('gitsight.refresh');
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: ${e.message}`);
      }
    },
  );
}

async function applyStash(git: Git, stash: Stash): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: apply ${stash.ref}` },
    async () => {
      try {
        await git.stashApply(stash.ref);
        vscode.window.setStatusBarMessage(`Applied ${stash.ref} (still stashed)`, 3000);
        vscode.commands.executeCommand('gitsight.refresh');
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: ${e.message}`);
      }
    },
  );
}

async function showStashDiff(git: Git, stash: Stash): Promise<void> {
  try {
    // `git stash show -u -p <ref>` includes untracked files when available.
    const diff = await git.raw(['stash', 'show', '-u', '-p', stash.ref]);
    const content = diff.trim() || `# Stash ${stash.ref} is empty (no changes recorded).`;
    const doc = await vscode.workspace.openTextDocument({ content, language: 'diff' });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: ${e.message}`);
  }
}

async function dropStash(git: Git, stash: Stash): Promise<void> {
  const subject = cleanStashSubject(stash.subject) || stash.ref;
  const ok = await vscode.window.showWarningMessage(
    `Drop ${stash.ref} (${subject})? This cannot be undone.`,
    { modal: true },
    'Drop',
  );
  if (ok !== 'Drop') return;
  try {
    await git.stashDrop(stash.ref);
    vscode.window.setStatusBarMessage(`Dropped ${stash.ref}`, 3000);
    vscode.commands.executeCommand('gitsight.refresh');
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: ${e.message}`);
  }
}
