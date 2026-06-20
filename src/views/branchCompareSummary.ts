/**
 * Branch Compare Summary (F26) — pick two branches, get a one-liner with
 * ahead/behind counts, shortstat (files + insertions/deletions), and the top
 * contributors on the head side. From the result the user can:
 *
 *   - open the full diff in an editor
 *   - open a markdown report with the full contributor breakdown
 *   - copy the one-line summary to the clipboard
 *
 * Pure parsing + rendering lives in src/git/branchCompare.ts and is fully
 * unit-tested; this controller is only wiring + UI.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import {
  parseLeftRightCount,
  parseShortStat,
  parseShortlog,
  summariseCompare,
  formatCompareMarkdown,
  BranchCompareSummary,
} from '../git/branchCompare';

const MAX_TOP_CONTRIBUTORS = 5;

async function pickRef(allNames: string[], placeHolder: string, current?: string): Promise<string | undefined> {
  // Pre-sort: current branch first, then locals, then remotes alphabetically.
  const sorted = [...allNames].sort((a, b) => {
    if (a === current) return -1;
    if (b === current) return 1;
    const aRemote = a.includes('/');
    const bRemote = b.includes('/');
    if (aRemote !== bRemote) return aRemote ? 1 : -1;
    return a.localeCompare(b);
  });
  return vscode.window.showQuickPick(sorted, { placeHolder, matchOnDescription: true });
}

export async function showBranchCompareSummary(git: Git, preset?: { base?: string; head?: string }): Promise<void> {
  const branches = await git.branches(true);
  if (branches.length < 2) {
    vscode.window.showInformationMessage('GitSight: need at least two branches to compare.');
    return;
  }
  const current = await git.currentBranch().catch(() => undefined);
  const names = branches.map(b => b.name);

  const base = preset?.base ?? await pickRef(names, 'Compare base (the "from" side)', current);
  if (!base) return;
  const head = preset?.head ?? await pickRef(names, `Compare head (vs ${base})`, current);
  if (!head) return;
  if (base === head) {
    vscode.window.showInformationMessage('GitSight: base and head are the same branch.');
    return;
  }

  const summary = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: comparing ${base} ↔ ${head}…` },
    () => buildSummary(git, base, head),
  );
  if (!summary) return;

  const line = summariseCompare(summary);
  // Quick action panel: copy / view diff / open report.
  type Action = 'copy' | 'diff' | 'report' | 'flip';
  type Item = vscode.QuickPickItem & { _action: Action };
  const choice = await vscode.window.showQuickPick<Item>(
    [
      { label: '$(clippy) Copy summary line', detail: line, _action: 'copy' },
      { label: '$(diff) Open full diff', detail: `git diff ${base}...${head}`, _action: 'diff' },
      { label: '$(notebook) Open detailed report', detail: 'Markdown with contributor breakdown', _action: 'report' },
      { label: '$(arrow-swap) Flip and compare again', detail: `${head} → ${base}`, _action: 'flip' },
    ],
    { placeHolder: line, matchOnDetail: true },
  );
  if (!choice) return;
  switch (choice._action) {
    case 'copy':
      await vscode.env.clipboard.writeText(line);
      vscode.window.setStatusBarMessage('GitSight: summary copied', 2000);
      break;
    case 'diff': {
      const diff = await git.diff({ from: base, to: head });
      const doc = await vscode.workspace.openTextDocument({
        content: diff || `# No diff between ${base} and ${head}`,
        language: 'diff',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      break;
    }
    case 'report': {
      const md = formatCompareMarkdown(summary);
      const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      break;
    }
    case 'flip':
      await showBranchCompareSummary(git, { base: head, head: base });
      break;
  }
}

async function buildSummary(git: Git, base: string, head: string): Promise<BranchCompareSummary | undefined> {
  try {
    const [revOut, statOut, shortlogOut] = await Promise.all([
      git.raw(['rev-list', '--left-right', '--count', `${base}...${head}`]).catch(() => ''),
      git.raw(['diff', '--shortstat', `${base}...${head}`]).catch(() => ''),
      git.raw(['shortlog', '-sne', '--no-merges', `${base}..${head}`]).catch(() => ''),
    ]);
    const counts = parseLeftRightCount(revOut);
    const diff = parseShortStat(statOut);
    const contributors = parseShortlog(shortlogOut);
    return {
      base, head, counts, diff,
      topContributors: contributors.slice(0, MAX_TOP_CONTRIBUTORS),
      contributorTotal: contributors.length,
    };
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: ${e.message}`);
    return undefined;
  }
}
