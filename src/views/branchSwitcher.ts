/**
 * Branch Quick-Switcher — keyboard-first switcher with recents, ahead/behind,
 * last commit author/subject/time, and an inline "Create new branch…" entry.
 *
 * Bound to Cmd+Shift+B (mac) / Ctrl+Shift+B. Stores last-used branches in a
 * workspace Memento so the most recently visited branches float to the top.
 */
import * as vscode from 'vscode';
import { Git, Branch } from '../git/git';
import { timeAgo } from '../git/format';

const RECENTS_KEY = 'gitsight.branchSwitcher.recents';
const MAX_RECENTS = 10;

type SwitcherItem = vscode.QuickPickItem & {
  _branch?: Branch;
  _action?: 'create' | 'create-from-input';
  _name?: string;
};

export async function showBranchQuickSwitcher(ctx: vscode.ExtensionContext, git: Git) {
  const recents = ctx.workspaceState.get<string[]>(RECENTS_KEY, []);
  const branches = await git.branches(true);
  if (!branches.length) {
    vscode.window.showInformationMessage('GitSight: no branches found.');
    return;
  }

  // Dedup: prefer the local copy when both `main` and `origin/main` exist.
  const seen = new Set<string>();
  const ordered: Branch[] = [];
  // Recents first (in recency order), if still present.
  for (const r of recents) {
    const hit = branches.find(b => b.name === r);
    if (hit && !seen.has(hit.name)) { ordered.push(hit); seen.add(hit.name); }
  }
  // Locals next.
  for (const b of branches.filter(b => !b.remote)) {
    if (!seen.has(b.name)) { ordered.push(b); seen.add(b.name); }
  }
  // Remotes last, with `origin/` skipping ones whose plain name is already local.
  for (const b of branches.filter(b => b.remote)) {
    const plain = b.name.replace(/^[^/]+\//, '');
    if (seen.has(plain)) continue;
    if (!seen.has(b.name)) { ordered.push(b); seen.add(b.name); }
  }

  const inRecents = (n: string) => recents.includes(n);
  const items: SwitcherItem[] = ordered.map(b => {
    const bits: string[] = [];
    if (b.upstream) bits.push(b.upstream);
    if (b.ahead) bits.push(`↑${b.ahead}`);
    if (b.behind) bits.push(`↓${b.behind}`);
    if (b.lastDate) bits.push(timeAgo(b.lastDate));
    if (b.lastAuthor) bits.push(b.lastAuthor);
    const prefix = b.current ? '$(star-full)' : b.remote ? '$(cloud)' : inRecents(b.name) ? '$(history)' : '$(git-branch)';
    return {
      label: `${prefix} ${b.name}`,
      description: bits.join('  '),
      detail: b.lastSubject ? `${b.sha.slice(0, 7)}  ${b.lastSubject}` : b.sha.slice(0, 7),
      _branch: b,
    };
  });

  // Always offer "Create new branch from current" at the bottom.
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
    { label: '$(add) Create new branch…', detail: 'From the current HEAD', _action: 'create' },
  );

  const qp = vscode.window.createQuickPick<SwitcherItem>();
  qp.items = items;
  qp.placeholder = 'Switch branch — type to filter, ↵ to checkout';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.title = 'GitSight: Switch Branch';

  // Live "create from input" item when typing something that isn't a branch.
  const allNames = new Set(branches.map(b => b.name));
  qp.onDidChangeValue(v => {
    const clean = v.trim();
    const dynamic: SwitcherItem[] = [];
    if (clean && !allNames.has(clean) && /^[^\s~^:?*\[\]\\]+$/.test(clean)) {
      dynamic.push({
        label: `$(add) Create branch "${clean}"`,
        detail: 'Create from current HEAD and checkout',
        _action: 'create-from-input',
        _name: clean,
        alwaysShow: true,
      });
    }
    qp.items = [...dynamic, ...items];
  });

  const picked = await new Promise<SwitcherItem | undefined>(resolve => {
    qp.onDidAccept(() => { resolve(qp.selectedItems[0]); qp.hide(); });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();

  if (!picked) return;

  if (picked._action === 'create') {
    const name = await vscode.window.showInputBox({
      prompt: 'New branch name',
      validateInput: v => allNames.has(v.trim()) ? 'Branch already exists' : undefined,
    });
    if (!name) return;
    await createAndCheckout(ctx, git, name.trim());
    return;
  }
  if (picked._action === 'create-from-input' && picked._name) {
    await createAndCheckout(ctx, git, picked._name);
    return;
  }
  if (picked._branch) {
    await checkoutBranch(ctx, git, picked._branch);
  }
}

async function checkoutBranch(ctx: vscode.ExtensionContext, git: Git, b: Branch) {
  const target = b.remote ? b.name.replace(/^[^/]+\//, '') : b.name;
  if (b.current) {
    vscode.window.setStatusBarMessage(`Already on ${target}`, 2000);
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: checkout ${target}` },
    async () => {
      try {
        await git.checkout(target);
        rememberRecent(ctx, target);
        vscode.window.setStatusBarMessage(`Switched to ${target}`, 2500);
        vscode.commands.executeCommand('gitsight.refresh');
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: ${e.message}`);
      }
    },
  );
}

async function createAndCheckout(ctx: vscode.ExtensionContext, git: Git, name: string) {
  try {
    await git.createBranch(name);
    await git.checkout(name);
    rememberRecent(ctx, name);
    vscode.window.setStatusBarMessage(`Created and switched to ${name}`, 2500);
    vscode.commands.executeCommand('gitsight.refresh');
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: ${e.message}`);
  }
}

function rememberRecent(ctx: vscode.ExtensionContext, name: string) {
  const prev = ctx.workspaceState.get<string[]>(RECENTS_KEY, []);
  const next = [name, ...prev.filter(n => n !== name)].slice(0, MAX_RECENTS);
  ctx.workspaceState.update(RECENTS_KEY, next);
}
