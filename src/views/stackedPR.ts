/**
 * Stacked PR Navigator — Graphite/Sapling-style stacked branch workflow.
 *
 * Concept: a "stack" is a linear chain of branches where each branch's upstream
 * (parent) is another local branch — e.g. `main → feat-auth-base → feat-auth-api → feat-auth-ui`.
 *
 * Operations:
 *   - Visualize the current stack
 *   - Switch up/down the stack
 *   - Rebase a branch onto its parent (after parent commits change)
 *   - Restack the entire chain
 *   - Submit (push all branches in stack to origin)
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';

interface StackNode {
  branch: string;
  parent: string | null;
  children: string[];
  current: boolean;
  ahead: number;
  behind: number;
  upstream?: string;
}

const TRUNKS = new Set(['main', 'master', 'develop', 'trunk']);

async function buildStackMap(git: Git): Promise<Map<string, StackNode>> {
  const branches = await git.branches(false); // local only
  const nodes = new Map<string, StackNode>();

  for (const b of branches) {
    nodes.set(b.name, {
      branch: b.name,
      parent: null,
      children: [],
      current: b.current,
      ahead: b.ahead || 0,
      behind: b.behind || 0,
      upstream: b.upstream,
    });
  }

  // Resolve parent: prefer git config `branch.<name>.gitsight-parent`,
  // else infer via merge-base with all other local branches (choose the one
  // whose merge-base with this branch is closest to this branch's tip).
  for (const node of Array.from(nodes.values())) {
    if (TRUNKS.has(node.branch)) continue;
    try {
      const cfg = (await git.run([
        'config', '--get', `branch.${node.branch}.gitsight-parent`,
      ])).trim();
      if (cfg && nodes.has(cfg)) {
        node.parent = cfg;
        continue;
      }
    } catch { /* not set */ }

    // Infer parent
    let bestParent: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const other of Array.from(nodes.values())) {
      if (other.branch === node.branch) continue;
      try {
        const mb = (await git.run(['merge-base', node.branch, other.branch])).trim();
        if (!mb) continue;
        // Distance = how many commits between merge-base and `other`'s tip.
        // The "true" parent is the one where merge-base == other's tip
        // (meaning `other` is an ancestor of `node`).
        const otherTip = (await git.run(['rev-parse', other.branch])).trim();
        if (mb !== otherTip) continue;
        const cnt = parseInt(
          (await git.run(['rev-list', '--count', `${mb}..${node.branch}`])).trim(),
          10,
        );
        if (!Number.isFinite(cnt)) continue;
        if (cnt < bestDistance) {
          bestDistance = cnt;
          bestParent = other.branch;
        }
      } catch { /* ignore */ }
    }
    // Prefer a non-trunk parent if equally close
    if (bestParent && TRUNKS.has(bestParent)) {
      for (const other of Array.from(nodes.values())) {
        if (other.branch === node.branch || TRUNKS.has(other.branch)) continue;
        if (other.branch === bestParent) continue;
        try {
          const otherTip = (await git.run(['rev-parse', other.branch])).trim();
          const mb = (await git.run(['merge-base', node.branch, other.branch])).trim();
          if (mb === otherTip) {
            bestParent = other.branch;
            break;
          }
        } catch { /* ignore */ }
      }
    }
    node.parent = bestParent;
  }

  // Build children
  for (const node of Array.from(nodes.values())) {
    if (node.parent && nodes.has(node.parent)) {
      nodes.get(node.parent)!.children.push(node.branch);
    }
  }

  return nodes;
}

function findStack(nodes: Map<string, StackNode>, start: string): string[] {
  // Walk up to root (trunk), collect the linear chain.
  const upChain: string[] = [];
  let cur: string | null = start;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    upChain.unshift(cur);
    cur = nodes.get(cur)?.parent ?? null;
  }
  // Walk down from the start picking linear descendants.
  const downChain: string[] = [];
  let head: string | null = start;
  while (true) {
    const n = nodes.get(head!);
    if (!n || n.children.length === 0) break;
    // If a branch has multiple children we can't pick one — stop.
    if (n.children.length > 1) break;
    head = n.children[0];
    if (seen.has(head)) break;
    seen.add(head);
    downChain.push(head);
  }
  return [...upChain, ...downChain];
}

export async function showStackedPRNavigator(git: Git) {
  const nodes = await buildStackMap(git);
  if (!nodes.size) return vscode.window.showInformationMessage('No local branches.');

  const current = Array.from(nodes.values()).find(n => n.current);
  if (!current) return vscode.window.showInformationMessage('Detached HEAD — checkout a branch first.');

  const stack = findStack(nodes, current.branch);
  const currentIdx = stack.indexOf(current.branch);

  type Item = vscode.QuickPickItem & { _action?: string; _branch?: string };
  const items: Item[] = [];

  // Stack visualization
  for (let i = stack.length - 1; i >= 0; i--) {
    const n = nodes.get(stack[i])!;
    const isTrunk = TRUNKS.has(n.branch);
    const cursor = n.current ? '▶' : ' ';
    const rail = isTrunk ? '◯' : (i === 0 ? '┴' : i === stack.length - 1 ? '┬' : '│');
    const status: string[] = [];
    if (n.ahead) status.push(`↑${n.ahead}`);
    if (n.behind) status.push(`↓${n.behind}`);
    items.push({
      label: `${cursor} ${rail}  ${n.branch}${isTrunk ? '  (trunk)' : ''}`,
      description: status.join(' '),
      detail: n.upstream ? `tracks ${n.upstream}` : undefined,
      _branch: n.branch,
    });
  }

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator } as any);

  const parent = nodes.get(current.branch)?.parent;
  const childCount = nodes.get(current.branch)?.children.length || 0;

  if (currentIdx > 0) items.push({ label: '$(arrow-up) Move up the stack', description: `→ ${stack[currentIdx - 1]}`, _action: 'up' });
  if (currentIdx < stack.length - 1) items.push({ label: '$(arrow-down) Move down the stack', description: `→ ${stack[currentIdx + 1]}`, _action: 'down' });
  if (parent && !TRUNKS.has(current.branch)) items.push({ label: '$(git-merge) Rebase onto parent', description: `${current.branch} ← ${parent}`, _action: 'rebase-parent' });
  items.push({ label: '$(sync) Restack chain', description: 'Rebase entire stack from trunk up', _action: 'restack' });
  items.push({ label: '$(cloud-upload) Submit stack', description: `Push all ${stack.filter(b => !TRUNKS.has(b)).length} branch(es) to origin`, _action: 'submit' });
  items.push({ label: '$(plus) Stack a new branch on top', description: `Create child of ${current.branch}`, _action: 'stack-new' });
  items.push({ label: '$(link) Set parent of current branch…', description: 'Override inferred parent', _action: 'set-parent' });
  if (childCount > 1) items.push({ label: '$(warning) Multiple children below this branch', description: 'Stack splits — pick one to continue navigating', kind: vscode.QuickPickItemKind.Separator } as any);

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Stack: ${stack.join(' → ')} · cursor on ${current.branch}`,
    matchOnDescription: true,
  });
  if (!picked) return;

  if (picked._branch && picked._branch !== current.branch) {
    return checkout(git, picked._branch);
  }
  switch (picked._action) {
    case 'up':   return checkout(git, stack[currentIdx - 1]);
    case 'down': return checkout(git, stack[currentIdx + 1]);
    case 'rebase-parent': return rebaseOnto(git, current.branch, parent!);
    case 'restack': return restackChain(git, nodes, stack);
    case 'submit': return submitStack(git, stack);
    case 'stack-new': return stackNew(git, current.branch);
    case 'set-parent': return setParent(git, nodes, current.branch);
  }
}

async function checkout(git: Git, branch: string) {
  try {
    await git.run(['checkout', branch]);
    vscode.window.showInformationMessage(`Switched to ${branch}`);
    vscode.commands.executeCommand('gitsight.refresh');
  } catch (e: any) {
    vscode.window.showErrorMessage(`Checkout failed: ${e?.message || e}`);
  }
}

async function rebaseOnto(git: Git, branch: string, parent: string) {
  const ok = await vscode.window.showWarningMessage(
    `Rebase '${branch}' onto '${parent}'?  History will be rewritten.`,
    { modal: true }, 'Rebase',
  );
  if (ok !== 'Rebase') return;
  try {
    await git.run(['checkout', branch]);
    await git.run(['rebase', parent]);
    vscode.window.showInformationMessage(`Rebased ${branch} onto ${parent} ✓`);
    vscode.commands.executeCommand('gitsight.refresh');
  } catch (e: any) {
    vscode.window.showErrorMessage(`Rebase failed (resolve conflicts, then 'git rebase --continue'): ${e?.message || e}`);
  }
}

async function restackChain(git: Git, nodes: Map<string, StackNode>, stack: string[]) {
  // Rebase each non-trunk branch in the stack onto its parent, in order from bottom to top.
  const startBranch = (await git.currentBranch());
  const nonTrunk = stack.filter(b => !TRUNKS.has(b));
  if (!nonTrunk.length) return vscode.window.showInformationMessage('Nothing to restack.');
  const ok = await vscode.window.showWarningMessage(
    `Restack ${nonTrunk.length} branch(es)?  ${nonTrunk.join(' → ')}`,
    { modal: true }, 'Restack',
  );
  if (ok !== 'Restack') return;
  for (const b of nonTrunk) {
    const p = nodes.get(b)?.parent;
    if (!p) continue;
    try {
      await git.run(['checkout', b]);
      await git.run(['rebase', p]);
    } catch (e: any) {
      vscode.window.showErrorMessage(
        `Restack stopped at ${b} (rebasing onto ${p}). Resolve, then re-run Restack.`,
      );
      return;
    }
  }
  try { await git.run(['checkout', startBranch]); } catch { /* ignore */ }
  vscode.window.showInformationMessage(`Restacked ${nonTrunk.length} branch(es) ✓`);
  vscode.commands.executeCommand('gitsight.refresh');
}

async function submitStack(git: Git, stack: string[]) {
  const branches = stack.filter(b => !TRUNKS.has(b));
  if (!branches.length) return vscode.window.showInformationMessage('Nothing to submit.');
  const force = await vscode.window.showWarningMessage(
    `Push ${branches.length} branch(es) to origin?\n${branches.join('\n')}`,
    { modal: true }, 'Push (force-with-lease)', 'Push (no force)',
  );
  if (!force) return;
  const args = ['push', '--atomic', 'origin', ...branches];
  if (force.startsWith('Push (force')) args.splice(1, 0, '--force-with-lease');
  try {
    await git.run(args);
    vscode.window.showInformationMessage(`Pushed ${branches.length} branch(es) ✓`);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Push failed: ${e?.message || e}`);
  }
}

async function stackNew(git: Git, parent: string) {
  const name = await vscode.window.showInputBox({
    prompt: `New branch on top of ${parent}`,
    placeHolder: 'feature/your-name',
    validateInput: v => !v ? 'Branch name required.' : (/[\s~^:?*[\]]/.test(v) ? 'Invalid character.' : null),
  });
  if (!name) return;
  try {
    await git.run(['checkout', '-b', name, parent]);
    await git.run(['config', `branch.${name}.gitsight-parent`, parent]);
    vscode.window.showInformationMessage(`Created ${name} on top of ${parent} ✓`);
    vscode.commands.executeCommand('gitsight.refresh');
  } catch (e: any) {
    vscode.window.showErrorMessage(`Failed to create branch: ${e?.message || e}`);
  }
}

async function setParent(git: Git, nodes: Map<string, StackNode>, branch: string) {
  const candidates = Array.from(nodes.keys()).filter(b => b !== branch);
  const picked = await vscode.window.showQuickPick(
    [{ label: '$(close) Clear parent (auto-infer)', description: '' }, ...candidates.map(b => ({ label: b, description: TRUNKS.has(b) ? '(trunk)' : '' }))],
    { placeHolder: `Set parent of ${branch}` },
  );
  if (!picked) return;
  try {
    if (picked.label.startsWith('$(close)')) {
      try { await git.run(['config', '--unset', `branch.${branch}.gitsight-parent`]); } catch { /* not set */ }
      vscode.window.showInformationMessage(`Cleared parent override for ${branch}.`);
    } else {
      await git.run(['config', `branch.${branch}.gitsight-parent`, picked.label]);
      vscode.window.showInformationMessage(`Parent of ${branch} → ${picked.label} ✓`);
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(`Failed to set parent: ${e?.message || e}`);
  }
}
