/**
 * Stash Diff Browser (F58) — drill into any stash and inspect its
 * per-file changes as proper VS Code diff editors.
 *
 * Existing surfaces:
 *   - showStashVisualizer (webview): patch-level partial apply UI.
 *   - showStashQuickSwitcher: jump between stashes.
 *
 * This is the missing middle layer: pick a stash, see a clean file
 * list with +/- counts and rename arrows, click any row to open the
 * native side-by-side diff between the stash's parent and the stash
 * itself. Plus a quick action row to compare the stash to the working
 * tree on the fly (useful when triaging "is this stash still relevant?").
 *
 * Flow:
 *   1. List stashes (Git.stashes()).
 *   2. Quick-pick the one to browse, with subject + date + author.
 *   3. Fetch name-status + numstat (both NUL-delimited), join into
 *      StashChange[] via the pure helper.
 *   4. Detect the `-u` untracked sub-commit (rev-list --parents -n 1).
 *   5. Render a second picker with a global-actions block + per-file
 *      rows. Selecting a file diffs <stash>^ vs <stash> for that path
 *      (or <stash> vs WORKING when the user picked the working-tree
 *      compare action).
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import {
  parseNameStatusZ,
  mergeNumstatZ,
  detectUntrackedParent,
  summariseStashContents,
  describeChange,
  StashChange,
  StashContents,
} from '../git/stashDiff';
import { diffRevisions } from '../git/virtualFs';

export async function showStashDiffBrowser(git: Git, preset?: { ref?: string }): Promise<void> {
  const stashes = await safeStashList(git);
  if (!stashes.length) {
    vscode.window.showInformationMessage('GitSight: no stashes.');
    return;
  }

  // 1. Pick stash (unless caller passed one in — e.g. from a tree action).
  let stashRef = preset?.ref;
  if (!stashRef) {
    type Pk = vscode.QuickPickItem & { _ref: string };
    const items: Pk[] = stashes.map(s => ({
      label: `$(archive) ${s.ref}`,
      description: s.subject || '(no message)',
      detail: `${s.branch ? `on ${s.branch} \u00b7 ` : ''}${timeAgo(s.date)}`,
      _ref: s.ref,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'GitSight: which stash to browse?',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    stashRef = picked._ref;
  }

  // 2. Fetch the contents.
  const contents = await loadStashContents(git, stashRef);
  if (!contents.changes.length) {
    vscode.window.showInformationMessage(`GitSight: ${stashRef} has no recorded file changes.`);
    return;
  }

  // 3. Picker: actions + per-file rows.
  await showFilePicker(git, contents);
}

async function showFilePicker(git: Git, contents: StashContents): Promise<void> {
  type Pk = vscode.QuickPickItem & { _action?: 'compare-working' | 'open-full' | 'apply' | 'pop'; _file?: StashChange };
  const items: Pk[] = [];

  items.push({
    label: `$(diff) Open full diff (${contents.ref})`,
    description: 'opens the patch as one scratch document',
    _action: 'open-full',
  });
  items.push({
    label: '$(git-compare) Compare each file to the working tree',
    description: 'opens N diff editors, one per file',
    _action: 'compare-working',
  });
  items.push({
    label: '$(check) Apply this stash',
    description: 'git stash apply (keeps the stash in the list)',
    _action: 'apply',
  });
  items.push({
    label: '$(arrow-up) Pop this stash',
    description: 'git stash pop (drops on success)',
    _action: 'pop',
  });
  items.push({
    label: 'Files',
    kind: vscode.QuickPickItemKind.Separator,
  } as Pk);
  for (const c of contents.changes) {
    const d = describeChange(c);
    items.push({
      label: `$(file) ${c.path}`,
      description: `[${d.glyph}] ${d.desc}`,
      _file: c,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${contents.ref} \u00b7 ${summariseStashContents(contents)}`,
    matchOnDescription: true,
  });
  if (!picked) return;

  if (picked._action === 'open-full') return openFullPatch(git, contents.ref);
  if (picked._action === 'compare-working') return diffEachToWorking(git, contents);
  if (picked._action === 'apply') return runStashCommand(git, ['stash', 'apply', contents.ref], `Applied ${contents.ref}`);
  if (picked._action === 'pop') return runStashCommand(git, ['stash', 'pop', contents.ref], `Popped ${contents.ref}`);
  if (picked._file) {
    await diffFileAgainstStashParent(git, contents.ref, picked._file);
  }
}

async function diffFileAgainstStashParent(git: Git, ref: string, c: StashChange): Promise<void> {
  // For renames/copies, the parent has the OLD path. Falling back to the
  // new path on the parent side will produce a "file not found" doc that
  // still renders as an empty editor — which reads "the file was created
  // in this stash" — so it's a useful soft fallback. We pick whichever
  // path the user is more likely to recognise.
  const leftPath = c.oldPath ?? c.path;
  await diffRevisions(git.cwd, leftPath, `${ref}^`, ref);
}

async function diffEachToWorking(git: Git, contents: StashContents): Promise<void> {
  if (contents.changes.length > 12) {
    const ok = await vscode.window.showWarningMessage(
      `GitSight: this stash has ${contents.changes.length} files. Open ${contents.changes.length} diff editors?`,
      { modal: true },
      'Open all',
    );
    if (ok !== 'Open all') return;
  }
  for (const c of contents.changes) {
    const rel = c.path;
    try {
      await diffRevisions(git.cwd, rel, contents.ref, 'WORKING');
    } catch (e: any) {
      // Skip but keep going.
      vscode.window.setStatusBarMessage(`GitSight: skipped ${rel} (${e.message ?? e})`, 3000);
    }
  }
}

async function openFullPatch(git: Git, ref: string): Promise<void> {
  const patch = await safe(git, ['stash', 'show', '-p', ref]);
  const doc = await vscode.workspace.openTextDocument({ content: patch || `# ${ref} has no patch content.`, language: 'diff' });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
}

async function runStashCommand(git: Git, args: string[], successMessage: string): Promise<void> {
  try {
    await git.raw(args);
    vscode.window.showInformationMessage(`GitSight: ${successMessage}.`);
    vscode.commands.executeCommand('gitsight.refresh');
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: ${args.join(' ')} failed: ${e.message ?? e}`);
  }
}

async function loadStashContents(git: Git, ref: string): Promise<StashContents> {
  const [nameStatus, numstat, revList] = await Promise.all([
    safe(git, ['stash', 'show', '--name-status', '-z', ref]),
    safe(git, ['stash', 'show', '--numstat', '-z', ref]),
    safe(git, ['rev-list', '--parents', '-n', '1', ref]),
  ]);
  const changes = mergeNumstatZ(parseNameStatusZ(nameStatus), numstat);
  return {
    ref,
    changes,
    hadUntracked: detectUntrackedParent(revList),
  };
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

async function safeStashList(git: Git) {
  try { return await git.stashes(); } catch { return []; }
}

function timeAgo(d: Date): string {
  const n = Date.now() - d.getTime();
  if (n < 60_000) return 'just now';
  if (n < 3_600_000) return `${Math.floor(n / 60_000)}m ago`;
  if (n < 86_400_000) return `${Math.floor(n / 3_600_000)}h ago`;
  if (n < 604_800_000) return `${Math.floor(n / 86_400_000)}d ago`;
  return d.toISOString().slice(0, 10);
}
