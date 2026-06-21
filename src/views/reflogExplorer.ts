/**
 * Reflog Explorer (F68) — keyboard-first picker over the FULL `git reflog`,
 * not just checkout events (which the existing F32 Recent Branches view
 * already surfaces).
 *
 * Use cases:
 *   - "I just `git reset --hard` and want to undo it" → pick the entry
 *     before the reset, choose `Copy SHA` or `Reset to this`.
 *   - "Where was HEAD before that rebase went sideways?" → filter to
 *     `rebase` chip, pick the (start) entry, peek the diff.
 *   - "Did I really merge that branch by accident?" → filter to merge,
 *     read the action line, copy the SHA to investigate.
 *
 * Each entry exposes a per-row action menu:
 *   - $(eye) Show diff (HEAD..<sha>)
 *   - $(clippy) Copy SHA
 *   - $(arrow-left) Reset --hard to this (modal warning)
 *   - $(diff) Diff this vs current HEAD
 *   - $(git-commit) Open commit detail
 *
 * Configurable via:
 *   gitsight.reflogExplorer.windowSize    (default 200)
 *   gitsight.reflogExplorer.defaultFilter (kinds[], default [])
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import {
  parseReflog,
  filterReflog,
  summariseReflog,
  glyphForKind,
  isHeadMove,
  FILTER_KIND_ORDER,
  ReflogActionKind,
  ReflogEntry,
} from '../git/reflog';
import { ageLabel } from '../git/recentBranches';

type EntryItem = vscode.QuickPickItem & { _entry: ReflogEntry };
type ActionItem = vscode.QuickPickItem & { _action: 'show' | 'copy' | 'reset' | 'diff' | 'detail' };
type FilterChip = vscode.QuickPickItem & { _filter: ReflogActionKind };

export async function showReflogExplorer(git: Git): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gitsight.reflogExplorer');
  const windowSize = clamp(cfg.get<number>('windowSize', 200) ?? 200, 20, 5000);
  const defaultFilter = new Set<ReflogActionKind>(
    (cfg.get<string[]>('defaultFilter') ?? []).filter(k =>
      FILTER_KIND_ORDER.includes(k as ReflogActionKind),
    ) as ReflogActionKind[],
  );

  const raw = await safe(git, ['reflog', '--date=iso-strict', `-n${windowSize}`]);
  const entries = parseReflog(raw);
  if (!entries.length) {
    vscode.window.showInformationMessage('GitSight: reflog is empty for this repo.');
    return;
  }

  let activeFilter: Set<ReflogActionKind> = defaultFilter;
  const picked = await pickEntry(entries, activeFilter);
  if (!picked) return;

  await handleEntryAction(git, picked);
}

async function pickEntry(
  entries: ReflogEntry[],
  initialFilter: Set<ReflogActionKind>,
): Promise<ReflogEntry | undefined> {
  const summary = summariseReflog(entries);
  let activeFilter = new Set(initialFilter);

  const filterButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('filter'),
    tooltip: 'Filter by action kind\u2026',
  };

  return new Promise<ReflogEntry | undefined>(resolve => {
    const qp = vscode.window.createQuickPick<EntryItem>();
    qp.title = `GitSight: Reflog Explorer \u2014 ${summary.total} entries`;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.buttons = [filterButton];
    const render = () => {
      const filtered = filterReflog(entries, activeFilter);
      qp.placeholder = activeFilter.size
        ? `Filter: ${[...activeFilter].join(', ')} \u00b7 ${filtered.length}/${summary.total}`
        : `All ${summary.total} entries \u00b7 newest first`;
      qp.items = filtered.map(toItem);
    };
    qp.onDidTriggerButton(async (b) => {
      if (b === filterButton) {
        const next = await pickFilter(summary, activeFilter);
        if (next) { activeFilter = next; render(); }
      }
    });
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      qp.hide();
      resolve(sel?._entry);
    });
    qp.onDidHide(() => resolve(undefined));
    render();
    qp.show();
  });
}

function toItem(e: ReflogEntry): EntryItem {
  const ago = ageLabel(e.dateIso);
  const shaTag = `HEAD@{${e.index}}`;
  const dangerHint = isHeadMove(e.kind) ? ' \u00b7 head move' : '';
  return {
    label: `$(${glyphForKind(e.kind)}) ${e.summary}`,
    description: `${e.sha.slice(0, 7)}  \u00b7  ${ago}${dangerHint}`,
    detail: `${shaTag} \u00b7 ${e.kind}  \u00b7  ${e.action}`,
    _entry: e,
  };
}

async function pickFilter(
  summary: ReturnType<typeof summariseReflog>,
  current: Set<ReflogActionKind>,
): Promise<Set<ReflogActionKind> | undefined> {
  const items: FilterChip[] = FILTER_KIND_ORDER
    .filter(k => summary.byKind[k] > 0)
    .map(k => ({
      label: `$(${glyphForKind(k)}) ${k}`,
      description: `${summary.byKind[k]} entries`,
      picked: current.has(k),
      _filter: k,
    }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Filter reflog entries',
    placeHolder: 'Tick the kinds you want to see (empty = show all)',
  });
  if (!picked) return undefined;
  return new Set(picked.map(p => p._filter));
}

async function handleEntryAction(git: Git, entry: ReflogEntry): Promise<void> {
  const actions: ActionItem[] = [
    { label: '$(git-commit) Open commit detail', detail: `git show ${entry.sha.slice(0, 7)}`, _action: 'detail' },
    { label: '$(diff) Diff this vs current HEAD', detail: `git diff ${entry.sha.slice(0, 7)}..HEAD`, _action: 'diff' },
    { label: '$(clippy) Copy SHA', detail: entry.sha, _action: 'copy' },
    { label: '$(eye) Show this commit\u2019s patch', detail: `git show --stat ${entry.sha.slice(0, 7)}`, _action: 'show' },
    { label: '$(discard) Reset --hard to this', detail: `git reset --hard ${entry.sha.slice(0, 7)}  \u2014  destructive`, _action: 'reset' },
  ];
  const picked = await vscode.window.showQuickPick(actions, {
    placeHolder: `${entry.summary} \u2014 ${entry.sha.slice(0, 7)} \u00b7 ${entry.kind}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  switch (picked._action) {
    case 'detail': return openDetail(git, entry);
    case 'diff':   return openDiffVsHead(git, entry);
    case 'copy':   return copySha(entry);
    case 'show':   return showPatch(git, entry);
    case 'reset':  return resetHard(git, entry);
  }
}

async function openDetail(git: Git, entry: ReflogEntry): Promise<void> {
  await vscode.commands.executeCommand('gitsight.showCommitDetail', git, entry.sha);
}

async function openDiffVsHead(git: Git, entry: ReflogEntry): Promise<void> {
  try {
    const diff = await git.raw(['diff', `${entry.sha}..HEAD`]);
    const doc = await vscode.workspace.openTextDocument({
      content: diff || `# ${entry.sha.slice(0, 7)} and HEAD are identical.`,
      language: 'diff',
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: ${e.message}`);
  }
}

async function copySha(entry: ReflogEntry): Promise<void> {
  await vscode.env.clipboard.writeText(entry.sha);
  vscode.window.setStatusBarMessage(`Copied ${entry.sha.slice(0, 7)}`, 2000);
}

async function showPatch(git: Git, entry: ReflogEntry): Promise<void> {
  try {
    const out = await git.show(entry.sha);
    const doc = await vscode.workspace.openTextDocument({ content: out, language: 'diff' });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: ${e.message}`);
  }
}

async function resetHard(git: Git, entry: ReflogEntry): Promise<void> {
  const ans = await vscode.window.showWarningMessage(
    `Run \`git reset --hard ${entry.sha.slice(0, 7)}\`?`,
    {
      modal: true,
      detail: `This will move HEAD and DISCARD any uncommitted changes.\n\nReflog target: ${entry.action}\nTimestamp: ${entry.dateIso}`,
    },
    'Reset',
  );
  if (ans !== 'Reset') return;
  try {
    await git.raw(['reset', '--hard', entry.sha]);
    vscode.window.setStatusBarMessage(`Reset to ${entry.sha.slice(0, 7)}`, 3000);
    vscode.commands.executeCommand('gitsight.refresh');
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: ${e.message}`);
  }
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
